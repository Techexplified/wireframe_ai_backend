// ─── modules/ai/ai.controller.ts — AI Generation Handler ─────────────────────
//
// Fixes applied:
//   AI-H-01: Mid-stream errors always refund via reservationId (never lost)
//   AI-H-03: res.on('close') → cancel OpenRouter stream + refund on client disconnect
//   CREDIT-C-01: Uses reservationId for all refund calls (not client-supplied cost/pool)
//   C-01: Charges cost based on resolved model (free users → DEFAULT_MODEL → 1 credit)
//   C-03: Uses DEFAULT_MODEL_KEY from constants
//   C-04: Passes reasoningTokens to computeCostUSD

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
