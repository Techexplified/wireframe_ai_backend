// ─── modules/webhooks/webhook.controller.ts — Webhook Handlers ────────────────
//
// Edge cases handled:
//  ① Signature verification before ANY logic
//  ② Idempotency via markEventProcessed (atomic unique insert)
//  ③ On business logic failure after idempotency mark → unmark so Dodo can retry
//  ④ paymentType normalized from both snake_case and camelCase metadata fields
//  ⑤ Top-up allowed even if plan expired between checkout and webhook (with warning)
//  ⑥ activatePlan / addTopUpCredits do NOT use upsert — user must pre-exist

import { Request, Response } from 'express';
import { verifyWebhookSignature } from '../payments/providers/dodo.provider';
import { markEventProcessed, unmarkEventProcessed } from '../../utils/idempotency';
import { activatePlan } from '../users/user.service';
import { addTopUpCredits } from '../credits/credit.service';
import { PlanId, TopUpPackId, TOPUP_PACKS } from '../../config/constants';
import { BadRequestError, UnauthorizedError, AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

export async function dodoWebhookHandler(
  req: Request & { rawBody?: Buffer },
  res: Response
): Promise<void> {
  const signature = req.headers['x-dodo-signature'] as string | undefined;
  const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  // ① Signature MUST be verified first — reject tampered requests immediately
  if (!verifyWebhookSignature(rawBody, signature || '')) {
    logger.warn('[webhook.controller] Invalid webhook signature from IP:', req.ip);
    throw new UnauthorizedError('Invalid webhook signature', 'invalid_signature');
  }

  const payload   = req.body;
  const eventId   = (payload.event_id || payload.data?.payment_id || payload.id) as string | undefined;
  const eventType = (payload.type || payload.event) as string | undefined;

  if (!eventId) {
    logger.error('[webhook.controller] Missing eventId in payload:', payload);
    throw new BadRequestError('Missing event identifier', 'invalid_payload');
  }

  // ② Idempotency check: atomic insert into processed_webhooks collection
  const isNewEvent = await markEventProcessed(eventId);
  if (!isNewEvent) {
    logger.info(`[webhook.controller] Duplicate event ${eventId} — skipping`);
    sendSuccess(res, { received: true, duplicate: true });
    return;
  }

  if (eventType !== 'payment.succeeded') {
    logger.info(`[webhook.controller] Ignored event type: ${eventType}`);
    sendSuccess(res, { received: true, ignored: true });
    return;
  }

  const metadata    = (payload.data?.metadata || payload.metadata || {}) as Record<string, unknown>;
  const figmaUserId = metadata.figmaUserId as string | undefined;

  // ④ Normalize paymentType — Dodo may return either snake_case or camelCase
  const paymentType = (metadata.paymentType || metadata.payment_type) as 'subscription' | 'topup' | undefined;

  if (!figmaUserId || !paymentType) {
    logger.error('[webhook.controller] Missing required metadata:', metadata);
    // Unmark so Dodo can retry if this was a transient metadata issue
    await unmarkEventProcessed(eventId);
    throw new BadRequestError('Missing figmaUserId or paymentType in metadata', 'invalid_metadata');
  }

  // ── Handle subscription activation ────────────────────────────────────────

  if (paymentType === 'subscription') {
    const planId = metadata.planId as PlanId | undefined;

    if (!planId || planId !== 'pro') {
      logger.error('[webhook.controller] Invalid planId in metadata:', planId);
      throw new BadRequestError('Invalid planId in metadata — only "pro" is valid', 'invalid_plan_id');
    }

    try {
      const updatedUser = await activatePlan(figmaUserId, planId);
      logger.info(`[webhook.controller] Subscription activated: ${planId} for ${figmaUserId}`);
      sendSuccess(res, {
        received:             true,
        activated_plan:       planId,
        credits:              updatedUser.credits,
        subscription_ends_at: updatedUser.subscription_ends_at,
      });
    } catch (err) {
      // ③ Critical: unmark idempotency so Dodo can retry successfully
      logger.error('[webhook.controller] activatePlan error — unmarking event for retry:', err);
      await unmarkEventProcessed(eventId).catch((e) =>
        logger.error('[webhook.controller] Failed to unmark event:', e)
      );
      throw new AppError('Subscription activation failed', 500, 'activation_failed');
    }
    return;
  }

  // ── Handle credit top-up ──────────────────────────────────────────────────

  if (paymentType === 'topup') {
    const packId = metadata.packId as TopUpPackId | undefined;

    if (!packId || !['small', 'medium', 'large'].includes(packId)) {
      logger.error('[webhook.controller] Invalid packId in metadata:', packId);
      throw new BadRequestError('Invalid packId in metadata', 'invalid_pack_id');
    }

    const creditsToAdd = TOPUP_PACKS[packId].credits;

    try {
      const result = await addTopUpCredits(figmaUserId, creditsToAdd);
      logger.info(`[webhook.controller] Top-up added: +${creditsToAdd} (${packId}) for ${figmaUserId}`);
      sendSuccess(res, {
        received:      true,
        topup_added:   creditsToAdd,
        topup_credits: result.topup_credits,
      });
    } catch (err) {
      // ③ Critical: unmark idempotency so Dodo can retry successfully
      logger.error('[webhook.controller] addTopUpCredits error — unmarking event for retry:', err);
      await unmarkEventProcessed(eventId).catch((e) =>
        logger.error('[webhook.controller] Failed to unmark event:', e)
      );
      throw new AppError('Top-up credit addition failed', 500, 'topup_failed');
    }
    return;
  }

  sendSuccess(res, { received: true });
}
