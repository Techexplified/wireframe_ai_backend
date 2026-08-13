// ─── modules/ai/ai.controller.ts — AI Generation Handler ─────────────────────
//
// POST /api/features/generate/start
//
// Flow:
//   1. Determine credit cost for the selected model
//   2. Check plan access & credit balance
//   3. Atomically reserve model-appropriate credits (pool tracked by service)
//   4. Call OpenRouter via callOpenRouterStream (gets telemetry stream result)
//   5. Set SSE headers + pipe telemetry-wrapped stream to Express res
//   6. After stream completes: log telemetry + update daily quota (non-blocking)
//   7. Refund CORRECT credit amount & pool on stream error

import { Request, Response } from 'express';
import { reserveCredits, refundCredits, logUsage } from '../credits/credit.service';
import { callOpenRouterStream } from './ai.service';
import { logAiRequest, computeCostUSD } from './ai.telemetry';
import { incrementDailyTokenUsage } from './middleware/ai.quota.middleware';
import { GenerateOptions } from './ai.types';
import { ForbiddenError, BadRequestError, BadGatewayError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { MODEL_CREDIT_COST, CREDIT_COST_GENERATE } from '../../config/constants';

// ── POST /api/features/generate/start ────────────────────────────────────────

export async function startGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;
  const figmaUserId = req.figmaUserId;

  // Parse generation params early so we can compute the credit cost
  const {
    prompt,
    device      = 'desktop',
    style       = 'minimal',
    fidelity    = 'high',
    model       = 'gpt-5-6-luna',
    maxTokens,
    temperature,
  } = req.body as Partial<GenerateOptions>;

  // Determine credit cost for the requested model key
  const cost = MODEL_CREDIT_COST[model] ?? CREDIT_COST_GENERATE;

  // Guard: plan access
  if (!isActive && credits === 0) {
    throw new ForbiddenError(
      'An active plan is required to generate wireframes. Please upgrade.',
      'plan_required'
    );
  }

  // Guard: pre-check credit balance with correct model cost
  const totalCredits = credits + topup_credits;
  if (totalCredits < cost) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. ${modelDisplayName(model)} costs ${cost} credit${cost > 1 ? 's' : ''} and you have ${totalCredits} remaining.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  // Validate prompt before deducting credits
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequestError('prompt is required and must be a non-empty string', 'invalid_request');
  }

  // Atomic credit reservation — reserveCredits returns which pool was used
  const reservation = await reserveCredits(figmaUserId, cost);
  if (!reservation.success) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. ${modelDisplayName(model)} costs ${cost} credit${cost > 1 ? 's' : ''}.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  // Use pool directly from reservation result — this is the critical fix:
  // previously computed from arithmetic which broke with variable costs
  const pool = reservation.pool;

  // Log usage (non-blocking)
  logUsage(figmaUserId, 'generate_wireframe', cost, prompt.slice(0, 80))
    .catch((err) => logger.warn('Log usage error:', err));

  // Build generation options — pass pre-computed complexity from budget middleware
  const opts: GenerateOptions = {
    prompt: prompt.trim(),
    device,
    style,
    fidelity,
    model,
    maxTokens,
    temperature,
    _complexity: req._aiComplexity, // from aiBudgetMiddleware (avoids re-scoring)
    _plan:       plan,
  };

  // Call OpenRouter — returns telemetry-wrapped stream result
  let streamResult;
  try {
    streamResult = await callOpenRouterStream(opts, plan);
  } catch (err: unknown) {
    // Refund CORRECT cost to CORRECT pool on OpenRouter call failure
    await refundCredits(figmaUserId, pool, cost)
      .catch((refundErr) => logger.warn('Refund credit error:', refundErr));
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('[ai.controller /start] OpenRouter call failed:', errMsg);
    throw new BadGatewayError(errMsg, 'ai_error');
  }

  // Send SSE headers (before piping — headers must be set before data)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Credits-Left', String(reservation.creditsLeft + reservation.topup_creditsLeft));
  res.setHeader('X-Credit-Pool', pool);
  res.setHeader('X-Credits-Deducted', String(cost));
  res.setHeader('X-Model-Used', streamResult.model);
  res.setHeader('X-Complexity-Score', String(streamResult.complexityScore));
  res.setHeader('X-Token-Budget', String(streamResult.tokenBudget));
  res.flushHeaders();

  // Pipe telemetry-wrapped stream to client
  streamResult.stream.pipe(res);

  // Handle stream errors — refund CORRECT cost to CORRECT pool + close response
  streamResult.stream.on('error', async (err: Error) => {
    logger.error('[ai.controller /start] Stream error:', err.message);
    await refundCredits(figmaUserId, pool, cost)
      .catch((refundErr) => logger.warn('Refund credit error:', refundErr));
    if (!res.writableEnded) res.end();
  });

  // After stream completes — log telemetry + update daily quota (both non-blocking)
  streamResult.stream.on('finish', async () => {
    if (!res.writableEnded) res.end();

    try {
      const telemetry = await streamResult.telemetryPromise;

      // Pillar 1: log AI request to MongoDB
      logAiRequest({
        figmaUserId,
        model:            streamResult.model,
        promptTokens:     telemetry.promptTokens,
        completionTokens: telemetry.completionTokens,
        reasoningTokens:  telemetry.reasoningTokens,
        totalTokens:      telemetry.totalTokens,
        estimatedCostUSD: computeCostUSD(streamResult.model, telemetry.promptTokens, telemetry.completionTokens),
        finishReason:     telemetry.finishReason,
        durationMs:       telemetry.durationMs,
        complexityScore:  streamResult.complexityScore,
        tokenBudget:      streamResult.tokenBudget,
        timestamp:        new Date(),
      }).catch((err) => logger.warn('[ai.controller] Telemetry log failed:', err));

      // Pillar 3: increment daily token quota counter
      incrementDailyTokenUsage(figmaUserId, telemetry.totalTokens)
        .catch((err) => logger.warn('[ai.controller] Daily quota update failed:', err));

      // Pillar 1: log a warning when output was truncated (finish_reason: length)
      if (telemetry.finishReason === 'length') {
        logger.warn(
          `[ai.controller] ⚠️ Truncated output (finish_reason: length) — user: ${figmaUserId}, model: ${streamResult.model}, tokens: ${telemetry.totalTokens}/${streamResult.tokenBudget}, complexity: ${streamResult.complexityScore}`
        );
      }

      logger.info(
        `[ai.controller] Generation complete — model: ${streamResult.model}, cost: ${cost} credits (${pool} pool), tokens: ${telemetry.promptTokens}+${telemetry.completionTokens}, usd: $${computeCostUSD(streamResult.model, telemetry.promptTokens, telemetry.completionTokens).toFixed(5)}, finish: ${telemetry.finishReason}, ${telemetry.durationMs}ms`
      );
    } catch (err) {
      logger.warn('[ai.controller] Post-stream telemetry processing error:', err);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function modelDisplayName(modelKey: string): string {
  const names: Record<string, string> = {
    'kimi-2-6':          'Kimi K2',
    'gpt-5-6-luna':      'GPT-5.6 Luna',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'gpt-4o':            'GPT-4o',
    'gemini-1-5':        'Gemini 2.0 Flash',
  };
  return names[modelKey] || modelKey;
}
