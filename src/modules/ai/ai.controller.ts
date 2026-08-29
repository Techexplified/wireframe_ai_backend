// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/ai/ai.controller.ts — AI Generation Handler (Streaming + Credit Settlement)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   Express handler for POST /api/features/generate/start endpoint\n//   Orchestrates: credit reservation → OpenRouter streaming → telemetry → credit settlement\n//   Ensures: at-most-once credit charging, mid-stream refunds, client disconnect handling\n//\n// ENTRY POINT:\n//   POST /api/features/generate/start\n//   Middleware stack BEFORE this handler:\n//     1. authMiddleware (attaches req.planState, req.figmaUserId)\n//     2. aiRateLimitMiddleware (enforces free: 1/30s, pro: 3/10s)\n//     3. aiQuotaMiddleware (enforces free: 50k/day, pro: 500k/day)\n//     4. aiBudgetMiddleware (enforces per-request cap: free $0.10, pro $0.80)\n//   So by the time startGenerationHandler is called:\n//     • User is authenticated (figmaUserId set)\n//     • User passed rate limit check\n//     • User passed daily quota check\n//     • Estimated cost fits per-request budget\n//     • req._aiComplexity contains complexity scoring (score, tokenBudget)\n//\n// CREDIT RESERVATION FLOW (prevents double-charging):\n//   \n//   Problem:\n//     • AI generation consumes variable tokens (actual = unknown until after completion)\n//     • We estimate tokens upfront (complexity scoring), but estimate might be wrong\n//     • If we deduct estimated credits upfront then find actual cost is lower: user overpaid\n//     • If we deduct estimated credits upfront then find actual cost is higher: user underpaid\n//   \n//   Solution: Atomic Credit Reservation + Deferred Settlement\n//     1. Reserve: Deduct estimated cost from user's balance (atomic transaction)\n//        • DB insert: credit_reservations { reservationId, userId, amount: 5, status: 'reserved' }\n//        • DB update: users.topup_credits -= 5 (or plan_credits)\n//        • Prevents: user generating multiple times beyond their balance\n//     2. Generate: Call OpenRouter API (streaming)\n//        • OpenRouter streams HTML + token counts\n//        • ai.telemetry.ts counts actual tokens as they flow\n//     3. Settle: After stream ends, update with actual cost\n//        • DB update: credit_reservations { status: 'completed', actual_cost: 4.8 }\n//        • No further credit changes (actual cost already deducted)\n//        • Prevents: double-charging (reserved amount already deducted)\n//     4. Refund: If generation fails, add credits back\n//        • Client calls POST /api/features/generate/refund { reservationId }\n//        • DB update: credit_reservations { status: 'refunded' }\n//        • DB update: users.topup_credits += 5 (restore)\n//        • Prevents: lost credits on error\n//\n// FLOW OVERVIEW (startGenerationHandler):\n//   \n//   1. PARSE REQUEST\n//      • Extract: prompt, device, style, fidelity, model, maxTokens from req.body\n//      • Example: { prompt: \"Dashboard\", device: \"desktop\", style: \"modern\" }\n//   \n//   2. MODEL RESOLUTION\n//      • Free users: always use DEFAULT_MODEL (gpt-5.6-luna)\n//      • Pro users: use requested model or route based on complexity\n//      • Compute cost: MODEL_CREDIT_COST[resolvedModelKey] (1-3 credits)\n//   \n//   3. VALIDATION\n//      • Check: user has active plan (if free, fail if credits=0)\n//      • Check: user has enough credits (credits + topup_credits >= cost)\n//      • Check: prompt is non-empty string\n//      • If any check fails: throw error (async caught by error.middleware)\n//   \n//   4. RESERVE CREDITS\n//      • Call: reserveCredits(figmaUserId, cost)\n//      • Returns: { success, reservationId, creditsLeft, pool }\n//      • If fails: throw 403 (insufficient credits)\n//      • If succeeds: credits are now frozen (reserved)\n//   \n//   5. PREPARE OPTIONS\n//      • Build: GenerateOptions with prompt, device, style, _complexity, _plan\n//      • Set: temperature = 0.3 (stable, not client-supplied 0.7)\n//      • Set: _complexity = complexity scoring from middleware\n//   \n//   6. CALL OPENROUTER\n//      • Call: callOpenRouterStream(opts, plan)\n//      • OpenRouter API: POST https://openrouter.ai/api/v1/chat/completions\n//      • Receive: stream (Transform) + telemetryPromise\n//      • If fails: refund, throw 502\n//   \n//   7. SEND SSE HEADERS\n//      • HTTP 200 OK\n//      • Content-Type: text/event-stream (Server-Sent Events)\n//      • Headers:\n//        - X-Credits-Deducted: cost (what was reserved)\n//        - X-Credit-Pool: 'topup' | 'plan' (which pool charged)\n//        - X-Reservation-Id: UUID (client uses for refund)\n//        - X-Model-Used: actual model name\n//        - X-Credits-Left: updated balance\n//   \n//   8. SETUP DISCONNECT HANDLER\n//      • res.on('close') fires if client closes connection mid-stream\n//      • Example: user closes Figma plugin while generation in progress\n//      • Action: cancel OpenRouter stream + refund via safeRefund()\n//   \n//   9. PIPE STREAM TO RESPONSE\n//      • res.pipe(streamResult.stream)\n//      • OpenRouter HTML chunks → Server-Sent Events → client\n//      • Client receives: event: token, data: <html>...</html>\n//   \n//   10. ERROR HANDLER (stream.on('error'))\n//       • If stream errors (network, OpenRouter error, etc.)\n//       • Action: refund via safeRefund('stream_error')\n//       • End response: res.end()\n//   \n//   11. COMPLETION HANDLER (stream.on('finish'))\n//       • After stream ends (all HTML sent)\n//       • Await: telemetryPromise (resolves with actual token counts)\n//       • Compute: actual cost in USD\n//       • Settle: mark reservation as completed\n//       • Log: telemetry (model, tokens, cost, timing)\n//       • Update: daily quota usage (incrementDailyTokenUsage)\n//   \n//   12. RESPONSE COMPLETE\n//       • Client has full HTML wireframe\n//       • Server has settled credits\n//       • Analytics logged\n//\n// CRITICAL GUARDS (prevent credit loss):\n//   \n//   streamSettled flag (line 89):\n//     • Tracks whether this stream has been handled (refund or settle)\n//     • Prevents: double-refund if disconnect + error both fire\n//     • Prevents: settle-after-refund (idempotent)\n//   \n//   safeRefund function (line 93):\n//     • Checks streamSettled before refunding\n//     • Logs reason (\"client_disconnect\", \"stream_error\", \"OpenRouter call failed\")\n//     • Awaits refundCredits (adds credits back to user)\n//     • Ignores refund errors (don't throw, just log)\n//   \n//   safeSettle function (line 99):\n//     • Checks streamSettled before settling\n//     • Awaits settleReservation (marks status='completed')\n//     • Ignores settle errors (don't throw, just log)\n//   \n//   Stream error handler (line 165):\n//     • fires if OpenRouter returns error or connection drops\n//     • Calls safeRefund('stream_error')\n//   \n//   Disconnect handler (line 158):\n//     • fires if res.on('close') (client closed connection)\n//     • Cancels OpenRouter stream (stop receiving from API)\n//     • Calls safeRefund('client_disconnect')\n//\n// MODEL RESOLUTION & COST CALCULATION:\n//   \n//   Why complex?\n//     • Different models have different costs (gpt-5.6-luna more expensive than deepseek)\n//     • Free users can't access expensive models\n//     • Cost must be known BEFORE calling OpenRouter (to reserve credits)\n//   \n//   Steps:\n//     1. Parse req.body.model (may be undefined, may be invalid)\n//     2. If plan='free': force to DEFAULT_MODEL (gpt-5.6-luna)\n//     3. If plan='pro': use requested model OR route based on complexity\n//     4. Look up MODEL_MAP[modelKey] → OpenRouter model ID\n//     5. Call resolveModel(modelId, complexity, plan) → returns OpenRouter ID\n//     6. Find MODEL_CREDIT_COST[modelKey] → cost in credits (1-3)\n//     7. Use cost for credit reservation\n//   \n//   Example (free user):\n//     • Client sends: { model: \"deepseek-v4-pro\", ... }\n//     • Handler: plan='free' → force DEFAULT_MODEL_KEY\n//     • Resolves to: gpt-5.6-luna\n//     • Cost: 1 credit\n//   \n//   Example (pro user, high complexity):\n//     • Client sends: { model: undefined, ... } (no preference)\n//     • Complexity score: 8 (complex wireframe)\n//     • Handler: resolveModel(default, 8, 'pro') → might route to gpt-5.6-luna\n//     • Cost: 2 credits\n//\n// STREAMING PROTOCOL (Server-Sent Events):\n//   \n//   Client:\n//     EventSource es = new EventSource('/api/features/generate/start?...')\n//     es.addEventListener('token', (event) => {\n//       // event.data = '<div>...</div>' (HTML chunk)\n//       appendToUI(event.data)\n//     })\n//   \n//   Server:\n//     res.write(\":connection established\\n\\n\")  // Initial SSE ping\n//     res.write(\"event: token\\ndata: <div>...</div>\\n\\n\")  // First chunk\n//     res.write(\"event: token\\ndata: <p>More content</p>\\n\\n\")  // Next chunk\n//     res.write(\"event: end\\ndata: {\\\"status\\\":\\\"success\\\"}\\n\\n\")  // Final event\n//     res.end()  // Close connection\n//   \n//   ai.service.ts wraps OpenRouter stream to inject SSE formatting\n//   ai.telemetry.ts counts tokens while transforming SSE\n//\n// ERROR HANDLING (always refund on error):\n//   \n//   1. OpenRouter API unavailable\n//      • Catch: try-catch at line 126\n//      • Action: safeRefund('OpenRouter call failed')\n//      • Throw: 502 BadGatewayError\n//      • Client receives: 502 + error message\n//   \n//   2. Stream error (network drops mid-generation)\n//      • Catch: stream.on('error') handler line 165\n//      • Action: safeRefund('stream_error')\n//      • Client receives: partial HTML + connection closes\n//      • Client calls: POST /api/features/generate/refund\n//   \n//   3. Client disconnect (user closes Figma)\\n//      • Catch: res.on('close') handler line 158\n//      • Action: cancel stream + safeRefund('client_disconnect')\n//      • OpenRouter stream stopped (don't waste compute)\n//      • Client calls: POST /api/features/generate/refund (optional)\n//   \n//   4. Invalid request (no prompt, bad device)\n//      • Catch: validation at line 76\n//      • Action: throw BadRequestError\n//      • Client receives: 400 + error message\n//      • Credits: not reserved (error before reservation)\n//   \n//   5. Insufficient credits (user has 0 credits, needs 2)\n//      • Catch: validation at lines 52, 79\n//      • Action: throw ForbiddenError\n//      • Client receives: 403 + error message + showTopup=true\n//      • Credits: not reserved (error before reservation)\n//\n// TELEMETRY & LOGGING:\n//   \n//   Pre-generation (line 110):\n//     • logUsage(figmaUserId, 'generate_wireframe', cost, pool, reservationId, prompt[:80])\n//     • Fires non-blocking (don't wait for result)\n//     • Records: intent to generate, user, cost, prompt preview\n//   \n//   Post-generation (line 167):\n//     • logAiRequest({\n//         model, promptTokens, completionTokens, reasoningTokens, totalTokens,\n//         estimatedCostUSD, finishReason, durationMs,\n//         complexityScore, tokenBudget, timestamp\n//       })\n//     • Records: actual generation results\n//     • Used for: analytics, model performance tracking, cost validation\n//   \n//   Daily quota update (line 177):\n//     • incrementDailyTokenUsage(figmaUserId, totalTokens)\n//     • Updates: daily_token_quotas collection\n//     • Used by: aiQuotaMiddleware for next request\n//   \n//   Warning: output truncated (line 179)\n//     • If finishReason='length': OpenRouter hit max_tokens\n//     • Means: HTML generation was cut off mid-element\n//     • Action: log warning (user might see broken HTML)\n//   \n//   Info: generation complete (line 182)\n//     • Summary: model, credits, cost, tokens, timing\n//     • Example: \"Done — model: gpt-5.6-luna, credits: 2, usd: $0.012, tokens: 145+1234+0r, finish: stop, 2134ms\"\n//\n// FIXES APPLIED:\n//   \n//   AI-H-01: Mid-stream errors always refund\n//     • Issue: Stream error → credits lost (no refund)\n//     • Fix: stream.on('error') → safeRefund('stream_error') always\n//     • Location: line 165\n//   \n//   AI-H-03: Client disconnect cancels OpenRouter + refunds\n//     • Issue: Client closes connection → OpenRouter keeps running (wastes compute)\n//     • Issue: Stream frozen → credits lost (no refund)\n//     • Fix: res.on('close') → cancelStream() + safeRefund('client_disconnect')\n//     • Location: line 158\n//   \n//   CREDIT-C-01: Uses reservationId for all refunds\n//     • Issue: Client could refund arbitrary amounts (\"refund me 1000 credits\")\n//     • Fix: All refunds use reservationId → server looks up exact amount\n//     • Location: line 155 (X-Reservation-Id header)\n//   \n//   C-01: Cost based on resolved model\n//     • Issue: Free user requests expensive model → costs more\n//     • Fix: Free users always use DEFAULT_MODEL (same cost)\n//     • Location: line 42\n//   \n//   C-03: Uses DEFAULT_MODEL_KEY properly\n//     • Issue: Inconsistent model key usage\n//     • Fix: All references use DEFAULT_MODEL_KEY constant\n//     • Location: line 42\n//   \n//   C-04: Passes reasoningTokens to cost calculation\n//     • Issue: Cost calculation ignored reasoningTokens\n//     • Fix: computeCostUSD(model, promptTokens, completionTokens, reasoningTokens)\n//     • Location: line 169\n//

import { Request, Response } from 'express';
import { reserveCredits, refundCredits, settleReservation, logUsage } from '../credits/credit.service';
import { callOpenRouterStream } from './ai.service';
import { logAiRequest, computeCostUSD } from './ai.telemetry';
import { incrementDailyTokenUsage } from './middleware/ai.quota.middleware';
import { resolveModel } from './ai.router';
import { GenerateOptions } from './ai.types';
import { ForbiddenError, BadRequestError, BadGatewayError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  MODEL_CREDIT_COST,
  CREDIT_COST_GENERATE,
  DEFAULT_MODEL_KEY,
  MODEL_MAP,
  DEFAULT_MODEL,
} from '../../config/constants';

// ── POST /api/features/generate/start ────────────────────────────────────────

export async function startGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;
  const figmaUserId = req.figmaUserId;

  const {
    prompt,
    device      = 'desktop',
    style       = 'minimal',
    fidelity    = 'high',
    model       = DEFAULT_MODEL_KEY,
    maxTokens,
  } = req.body as Partial<GenerateOptions>;

  // Enforce free tier model restriction: Only GPT 5.6 Luna is available on free trial
  const requestedModel  = plan === 'free' ? DEFAULT_MODEL_KEY : model;
  const rawModel        = MODEL_MAP[requestedModel] ?? (requestedModel.includes('/') ? requestedModel : DEFAULT_MODEL);
  const resolvedModelId = resolveModel(rawModel, req._aiComplexity?.score ?? 0, plan);
  const resolvedModelKey = Object.entries(MODEL_MAP).find(([, v]) => v === resolvedModelId)?.[0] ?? requestedModel;
  const cost = MODEL_CREDIT_COST[resolvedModelKey] ?? CREDIT_COST_GENERATE;

  // Guard: plan access
  if (!isActive && credits === 0) {
    throw new ForbiddenError(
      'An active plan is required to generate wireframes. Please upgrade.',
      'plan_required'
    );
  }

  // Guard: pre-check credit balance
  if (credits + topup_credits < cost) {
    throw new ForbiddenError(
      plan === 'free'
        ? 'No credits remaining. Please upgrade to a plan.'
        : `Not enough credits. ${modelDisplayName(resolvedModelKey)} costs ${cost} credit${cost > 1 ? 's' : ''} and you have ${credits + topup_credits} remaining.`,
      'insufficient_credits',
      isActive
    );
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequestError('prompt is required and must be a non-empty string', 'invalid_request');
  }

  // Fix C-03: Use DEFAULT_MODEL_KEY properly; atomic credit reservation with server-side tracking
  const reservation = await reserveCredits(figmaUserId, cost);
  if (!reservation.success) {
    throw new ForbiddenError(
      plan === 'free'
        ? 'No credits remaining. Please upgrade to a plan.'
        : `Not enough credits. ${modelDisplayName(resolvedModelKey)} costs ${cost} credit${cost > 1 ? 's' : ''}.`,
      'insufficient_credits',
      isActive
    );
  }

  const { reservationId, pool } = reservation;

  // Track whether the stream has been handled (prevent double-refund on concurrent events)
  let streamSettled = false;

  const safeRefund = async (reason: string) => {
    if (streamSettled) return;
    streamSettled = true;
    logger.info(`[ai.controller] Refunding reservation ${reservationId} — reason: ${reason}`);
    await refundCredits(figmaUserId, reservationId).catch((e) =>
      logger.warn('[ai.controller] Refund failed:', e)
    );
  };

  const safeSettle = async () => {
    if (streamSettled) return;
    streamSettled = true;
    await settleReservation(reservationId).catch((e) =>
      logger.warn('[ai.controller] Settle failed:', e)
    );
  };

  // Non-blocking usage log (pre-generation — records intent)
  logUsage(figmaUserId, 'generate_wireframe', cost, pool, reservationId, prompt.slice(0, 80))
    .catch((err) => logger.warn('[ai.controller] logUsage error:', err));

  const opts: GenerateOptions = {
    prompt: prompt.trim(),
    device,
    style,
    fidelity,
    model,
    maxTokens,
    temperature:  0.3,   // Fix AI-M-01: override client-sent 0.7 — use stable server default
    _complexity:  req._aiComplexity,
    _plan:        plan,
  };

  // Call OpenRouter — get telemetry-wrapped stream + cancel function
  let streamResult: Awaited<ReturnType<typeof callOpenRouterStream>>;
  try {
    streamResult = await callOpenRouterStream(opts, plan);
  } catch (err: unknown) {
    await safeRefund('OpenRouter call failed');
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('[ai.controller] OpenRouter call failed:', errMsg);
    throw new BadGatewayError(errMsg, 'ai_error');
  }

  // Send SSE headers before any data
  res.setHeader('Content-Type',         'text/event-stream');
  res.setHeader('Cache-Control',        'no-cache');
  res.setHeader('Connection',           'keep-alive');
  res.setHeader('X-Credits-Deducted',   String(cost));
  res.setHeader('X-Credit-Pool',        pool);
  res.setHeader('X-Reservation-Id',     reservationId);    // Fix CREDIT-C-01: client needs this for refund
  res.setHeader('X-Model-Used',         streamResult.model);
  res.setHeader('X-Complexity-Score',   String(streamResult.complexityScore));
  res.setHeader('X-Token-Budget',       String(streamResult.tokenBudget));
  res.setHeader('X-Credits-Left',       String(reservation.creditsLeft + reservation.topup_creditsLeft));
  res.flushHeaders();

  // Fix AI-H-03: Client disconnect → cancel OpenRouter stream + refund
  res.on('close', async () => {
    if (!res.writableEnded && !streamSettled) {
      logger.info(`[ai.controller] Client disconnected mid-stream — cancelling and refunding for ${figmaUserId}`);
      if (streamResult.cancelStream) streamResult.cancelStream();
      await safeRefund('client_disconnect');
    }
  });

  // Pipe the SSE stream to the response
  streamResult.stream.pipe(res);

  // Fix AI-H-01: Stream error → always refund via reservationId
  streamResult.stream.on('error', async (err: Error) => {
    logger.error('[ai.controller] Stream error:', err.message);
    await safeRefund('stream_error');
    if (!res.writableEnded) res.end();
  });

  // Stream complete — log telemetry + settle reservation
  streamResult.stream.on('finish', async () => {
    if (!res.writableEnded) res.end();

    try {
      const telemetry = await streamResult.telemetryPromise;

      // Fix C-04: Pass reasoningTokens to computeCostUSD
      const realCostUSD = computeCostUSD(
        streamResult.model,
        telemetry.promptTokens,
        telemetry.completionTokens,
        telemetry.reasoningTokens
      );

      // Settle the reservation — generation delivered, do not refund
      await safeSettle();

      logAiRequest({
        figmaUserId,
        model:            streamResult.model,
        promptTokens:     telemetry.promptTokens,
        completionTokens: telemetry.completionTokens,
        reasoningTokens:  telemetry.reasoningTokens,
        totalTokens:      telemetry.totalTokens,
        estimatedCostUSD: realCostUSD,
        finishReason:     telemetry.finishReason,
        durationMs:       telemetry.durationMs,
        complexityScore:  streamResult.complexityScore,
        tokenBudget:      streamResult.tokenBudget,
        timestamp:        new Date(),
      }).catch((e) => logger.warn('[ai.controller] Telemetry log failed:', e));

      incrementDailyTokenUsage(figmaUserId, telemetry.totalTokens)
        .catch((e) => logger.warn('[ai.controller] Daily quota update failed:', e));

      if (telemetry.finishReason === 'length') {
        logger.warn(
          `[ai.controller] Truncated output — model: ${streamResult.model}, tokens: ${telemetry.totalTokens}/${streamResult.tokenBudget}, user: ${figmaUserId}`
        );
      }

      logger.info(
        `[ai.controller] Done — model: ${streamResult.model}, credits: ${cost} (${pool}), usd: $${realCostUSD.toFixed(5)}, tokens: ${telemetry.promptTokens}+${telemetry.completionTokens}+${telemetry.reasoningTokens}r, finish: ${telemetry.finishReason}, ${telemetry.durationMs}ms`
      );
    } catch (err) {
      logger.warn('[ai.controller] Post-stream processing error:', err);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gpt-5-6-luna':      'GPT-5.6 Luna',
  'deepseek-v4-pro':   'DeepSeek V4 Pro',
  'gemini-3-7':        'Gemini 3.7 Flash',
  'kimi-2-6':          'Kimi K2',
  'gpt-4o':            'GPT-4o',
};

function modelDisplayName(modelKey: string): string {
  return MODEL_DISPLAY_NAMES[modelKey] || modelKey;
}
