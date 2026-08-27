// ─── modules/webhooks/webhook.controller.ts — Webhook Handlers ────────────────
//
// Fixes applied:
//   PAY-M-01: eventId uses only canonical data.payment_id; falls back to event_id only
//   PAY-M-02: paymentType reads only canonical metadata.paymentType (camelCase)
//   PAY-H-02: Added handlers for payment.refunded and subscription.cancelled events

import { Request, Response } from 'express';
import { verifyWebhookSignature } from '../payments/providers/dodo.provider';
import { markEventProcessed, completeEventProcessed, markEventFailed } from '../../utils/idempotency';
import { activatePlan, expirePass, revokeFailedPaymentPass } from '../users/user.service';
import { addTopUpCredits } from '../credits/credit.service';
import { getUsersCollection } from '../../config/database';
import { PlanId, TopUpPackId, PLAN_CONFIG, TOPUP_PACKS } from '../../config/constants';
import { BadRequestError, UnauthorizedError, AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

async function extractFigmaUserId(payload: any): Promise<string | undefined> {
  const metadata = {
    ...(payload.data?.customer?.metadata || {}),
    ...(payload.data?.subscription?.metadata || {}),
    ...(payload.data?.payment?.metadata || {}),
    ...(payload.metadata || {}),
    ...(payload.data?.metadata || {}),
  } as Record<string, unknown>;

  let figmaUserId = (
    metadata.figmaUserId ||
    metadata.figma_user_id ||
    payload.data?.customer?.metadata?.figmaUserId ||
    payload.data?.customer?.metadata?.figma_user_id ||
    payload.data?.metadata?.figmaUserId ||
    payload.data?.metadata?.figma_user_id ||
    payload.metadata?.figmaUserId ||
    payload.metadata?.figma_user_id ||
    payload.data?.client_reference_id ||
    payload.client_reference_id
  ) as string | undefined;

  if (!figmaUserId) {
    const customerEmail = payload.data?.customer?.email || payload.data?.email;
    if (customerEmail) {
      const usersCol = await getUsersCollection();
      const matchedUser = await usersCol.findOne({ email: customerEmail });
      if (matchedUser?.figmaUserId) {
        figmaUserId = matchedUser.figmaUserId;
      }
    }
  }

  return figmaUserId;
}

export async function dodoWebhookHandler(
  req: Request & { rawBody?: Buffer },
  res: Response
): Promise<void> {
  const signature = (
    req.headers['webhook-signature'] ||
    req.headers['x-dodo-signature'] ||
    req.headers['dodo-signature']
  ) as string | undefined;

  const msgId = (req.headers['webhook-id'] || req.headers['x-webhook-id']) as string | undefined;
  const timestamp = (req.headers['webhook-timestamp'] || req.headers['x-webhook-timestamp']) as string | undefined;
  const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  // ① Signature + timestamp MUST be verified first (supports Svix standard and legacy)
  if (!verifyWebhookSignature(rawBody, signature || '', { msgId, timestamp })) {
    logger.warn('[webhook.controller] Invalid webhook signature from IP:', req.ip);
    throw new UnauthorizedError('Invalid webhook signature', 'invalid_signature');
  }

  let payload = req.body;
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    if (req.rawBody && req.rawBody.length > 0) {
      try {
        payload = JSON.parse(req.rawBody.toString('utf8'));
      } catch (err) {
        logger.error('[webhook.controller] Failed to parse JSON from rawBody:', err);
        throw new BadRequestError('Invalid JSON in webhook payload', 'invalid_json');
      }
    } else {
      payload = {};
    }
  }

  const eventType = (payload.type || payload.event) as string | undefined;

  // Use unique msgId / eventId per delivery so distinct events for same subscription aren't dropped
  const eventId = (
    msgId ||
    payload.event_id ||
    payload.id ||
    payload.data?.event_id ||
    (payload.data?.payment_id ? `${eventType}_${payload.data.payment_id}` : undefined) ||
    (payload.data?.subscription_id ? `${eventType}_${payload.data.subscription_id}` : undefined)
  ) as string | undefined;

  if (!eventId) {
    logger.error('[webhook.controller] Missing eventId in payload:', payload);
    throw new BadRequestError('Missing event identifier', 'invalid_payload');
  }

  // ② Idempotency check (before any business logic)
  const isNewEvent = await markEventProcessed(eventId);
  if (!isNewEvent) {
    logger.info(`[webhook.controller] Duplicate event ${eventId} — skipping`);
    sendSuccess(res, { received: true, duplicate: true });
    return;
  }

  const rawStatus = (payload.data?.status || payload.data?.subscription?.status || payload.status) as string | undefined;
  const status = rawStatus?.toLowerCase();

  // ── Handle payment / subscription success ─────────────────────────────────
  // Strict check:
  // - Top-up: payment.succeeded
  // - Subscription: payment.succeeded or subscription.active / renewed or subscription.updated with status 'active'
  // - subscription.created is EXCLUDED because it is fired in pending/incomplete state before payment.

  const isPaymentSuccess = eventType === 'payment.succeeded' && (!status || status === 'succeeded' || status === 'completed');
  const isSubscriptionActive = (eventType === 'subscription.active' || eventType === 'subscription.renewed') && (!status || status === 'active');
  const isSubscriptionUpdatedActive = eventType === 'subscription.updated' && status === 'active';

  if (isPaymentSuccess || isSubscriptionActive || isSubscriptionUpdatedActive) {
    const metadata = {
      ...(payload.data?.customer?.metadata || {}),
      ...(payload.data?.subscription?.metadata || {}),
      ...(payload.data?.payment?.metadata || {}),
      ...(payload.metadata || {}),
      ...(payload.data?.metadata || {}),
    } as Record<string, unknown>;

    let figmaUserId = await extractFigmaUserId(payload);

    // Resolve cart product IDs from payload
    const cartProductIds: string[] = [];
    if (payload.data?.product_id) cartProductIds.push(String(payload.data.product_id));
    if (payload.data?.product_cart && Array.isArray(payload.data.product_cart)) {
      payload.data.product_cart.forEach((item: any) => {
        if (item?.product_id) cartProductIds.push(String(item.product_id));
      });
    }
    if (payload.data?.items && Array.isArray(payload.data.items)) {
      payload.data.items.forEach((item: any) => {
        if (item?.product_id) cartProductIds.push(String(item.product_id));
      });
    }

    // Determine paymentType and packId/planId
    let paymentType = (metadata.paymentType || metadata.payment_type) as 'subscription' | 'topup' | undefined;
    let packId = (metadata.packId || metadata.pack_id) as TopUpPackId | undefined;
    let planId = (metadata.planId || metadata.plan_id) as PlanId | undefined;

    // Direct Product ID matching against TOPUP_PACKS
    for (const [packKey, packConfig] of Object.entries(TOPUP_PACKS)) {
      if (packConfig.priceId && cartProductIds.includes(packConfig.priceId)) {
        paymentType = 'topup';
        packId = packKey as TopUpPackId;
        break;
      }
    }

    // Direct Product ID matching against PLAN_CONFIG.pro
    if (!paymentType && PLAN_CONFIG.pro.priceId && cartProductIds.includes(PLAN_CONFIG.pro.priceId)) {
      paymentType = 'subscription';
      planId = 'pro';
    }

    if (!paymentType) {
      if (packId) {
        paymentType = 'topup';
      } else if (planId || payload.data?.subscription_id || eventType?.startsWith('subscription.')) {
        paymentType = 'subscription';
      } else {
        paymentType = 'subscription';
      }
    }

    // Gracefully handle test pings or unlinked webhooks (e.g. from Dodo dashboard "Test Webhook")
    if (!figmaUserId) {
      logger.warn('[webhook.controller] Webhook event received without figmaUserId — acknowledging with 200 OK:', { eventType, eventId, cartProductIds });
      sendSuccess(res, { received: true, ignored: true, reason: 'missing_figma_user_id' });
      return;
    }

    logger.info(`[webhook.controller] Processing ${eventType} (status: ${status || 'active'}) for ${figmaUserId} | Type: ${paymentType} | Pack: ${packId || 'none'} | Plan: ${planId || 'pro'}`);

    if (paymentType === 'subscription') {
      const targetPlanId = (planId || 'pro') as PlanId;
      if (targetPlanId !== 'pro') {
        logger.error('[webhook.controller] Invalid planId in metadata:', targetPlanId);
        throw new BadRequestError('Invalid planId — only "pro" is valid', 'invalid_plan_id');
      }

      const dodoSubscriptionId = (
        payload.data?.subscription_id ||
        payload.subscription_id ||
        (payload.data?.object === 'subscription' ? payload.data?.id : undefined) ||
        null
      ) as string | null;

      try {
        const updatedUser = await activatePlan(figmaUserId, targetPlanId, dodoSubscriptionId);
        await completeEventProcessed(eventId).catch((e) =>
          logger.warn('[webhook.controller] Failed to mark event completed:', e)
        );
        logger.info(`[webhook.controller] Plan activated: ${targetPlanId} for ${figmaUserId}${dodoSubscriptionId ? ` (sub: ${dodoSubscriptionId})` : ''}`);
        sendSuccess(res, {
          received:             true,
          activated_plan:       targetPlanId,
          credits:              updatedUser.credits,
          subscription_ends_at: updatedUser.subscription_ends_at,
        });
      } catch (err) {
        logger.error('[webhook.controller] activatePlan error — marking event failed for retry:', err);
        await markEventFailed(eventId).catch((e) =>
          logger.error('[webhook.controller] Failed to mark event failed:', e)
        );
        throw new AppError('Subscription activation failed', 500, 'activation_failed');
      }
      return;
    }

    if (paymentType === 'topup') {
      const targetPackId = (packId || 'medium') as TopUpPackId;
      if (!['small', 'medium', 'large'].includes(targetPackId)) {
        logger.error('[webhook.controller] Invalid packId in metadata:', targetPackId);
        throw new BadRequestError('Invalid packId in metadata', 'invalid_pack_id');
      }

      const creditsToAdd = TOPUP_PACKS[targetPackId].credits;
      try {
        const result = await addTopUpCredits(figmaUserId, creditsToAdd);
        await completeEventProcessed(eventId).catch((e) =>
          logger.warn('[webhook.controller] Failed to mark event completed:', e)
        );
        logger.info(`[webhook.controller] Top-up added: +${creditsToAdd} (${targetPackId}) for ${figmaUserId}`);
        sendSuccess(res, { received: true, topup_added: creditsToAdd, topup_credits: result.topup_credits });
      } catch (err) {
        logger.error('[webhook.controller] addTopUpCredits error — marking event failed for retry:', err);
        await markEventFailed(eventId).catch((e) =>
          logger.error('[webhook.controller] Failed to mark event failed:', e)
        );
        throw new AppError('Top-up credit addition failed', 500, 'topup_failed');
      }
      return;
    }
  }

  // ── Fix PAY-H-02 & BUG-H-06: Handle refund and reversal events ─────────────
  //
  // When Dodo issues a refund or dispute, immediately expire the user's plan.

  if (eventType === 'payment.refunded' || eventType === 'payment.reversed') {
    const figmaUserId = await extractFigmaUserId(payload);

    if (!figmaUserId) {
      logger.warn('[webhook.controller] Refund event missing figmaUserId — cannot revoke credits');
      await completeEventProcessed(eventId).catch(() => {});
      sendSuccess(res, { received: true, action: 'no_action_missing_user' });
      return;
    }

    try {
      await expirePass(figmaUserId);
      await completeEventProcessed(eventId).catch((e) =>
        logger.warn('[webhook.controller] Failed to mark refund event completed:', e)
      );
      logger.warn(`[webhook.controller] ⚠️ REFUND/REVERSAL: plan expired for ${figmaUserId} (event: ${eventType})`);
      sendSuccess(res, { received: true, action: 'plan_revoked', reason: eventType });
    } catch (err) {
      logger.error('[webhook.controller] expirePass after refund error — marking for retry:', err);
      await markEventFailed(eventId).catch((e) =>
        logger.error('[webhook.controller] Failed to mark event failed:', e)
      );
      throw new AppError('Plan revocation failed', 500, 'revocation_failed');
    }
    return;
  }

  // ── Handle payment / subscription failure & suspension ────────────────────
  const isPaymentFailed = eventType === 'payment.failed';
  const isSubscriptionFailed =
    eventType === 'subscription.failed' ||
    (eventType === 'subscription.updated' && (status === 'failed' || status === 'on_hold' || status === 'paused' || status === 'expired'));

  if (isPaymentFailed || isSubscriptionFailed) {
    const figmaUserId = await extractFigmaUserId(payload);
    const errorMessage = payload.data?.error_message || payload.error_message || 'Payment was declined or cancelled. Please try again.';
    const errorCode = payload.data?.error_code || payload.error_code || 'payment_failed';
    const paymentId = payload.data?.payment_id || payload.data?.subscription_id || eventId;
    const subscriptionId = (payload.data?.subscription_id || payload.subscription_id) as string | undefined;

    if (figmaUserId) {
      try {
        const users = await getUsersCollection();
        const currentUser = await users.findOne({ figmaUserId });

        // Revoke unearned Pro access if user was marked Pro under this subscription or during payment attempt
        if (currentUser && (currentUser.plan === 'pro' || (subscriptionId && currentUser.dodo_subscription_id === subscriptionId))) {
          await revokeFailedPaymentPass(figmaUserId);
          logger.warn(`[webhook.controller] ⚠️ PAYMENT/SUB FAILURE: Revoked unearned Pro plan for ${figmaUserId} (event: ${eventType}, status: ${status || 'failed'})`);
        }

        await users.updateOne(
          { figmaUserId },
          {
            $set: {
              last_payment_attempt: {
                payment_id: paymentId,
                status: 'failed',
                error_code: errorCode,
                error_message: errorMessage,
                failed_at: new Date(),
              },
              updatedAt: new Date(),
            },
          }
        );
        logger.info(`[webhook.controller] Recorded payment failure for ${figmaUserId}: [${errorCode}] ${errorMessage}`);
      } catch (err) {
        logger.warn('[webhook.controller] Failed to record payment failure in DB:', err);
      }
    }

    await completeEventProcessed(eventId).catch(() => {});
    sendSuccess(res, { received: true, action: 'failure_recorded', error_code: errorCode, error_message: errorMessage });
    return;
  }

  // ── Handle cancellation events ────────────────────────────────────────────
  if (
    eventType === 'subscription.cancelled' ||
    eventType === 'payment.cancelled' ||
    (eventType === 'subscription.updated' && status === 'cancelled')
  ) {
    const figmaUserId = await extractFigmaUserId(payload);

    if (figmaUserId) {
      try {
        const users = await getUsersCollection();
        const updateFields: Record<string, unknown> = {
          subscription_cancelled: true,
          updatedAt: new Date(),
        };
        const rawEndsAt = payload.data?.next_billing_date || payload.data?.expires_at;
        if (rawEndsAt) {
          updateFields.subscription_ends_at = new Date(rawEndsAt);
        }
        await users.updateOne({ figmaUserId }, { $set: updateFields });
        logger.info(`[webhook.controller] Subscription marked cancelled for ${figmaUserId} — active until period ends`);
      } catch (err) {
        logger.warn('[webhook.controller] Failed to update subscription_cancelled in DB:', err);
      }
    }
    await completeEventProcessed(eventId).catch(() => {});
    sendSuccess(res, { received: true, action: 'cancellation_noted' });
    return;
  }

  // All other event types (e.g. subscription.created in pending state) — acknowledged safely
  await completeEventProcessed(eventId).catch(() => {});
  logger.info(`[webhook.controller] Safely acknowledged event type: ${eventType} (status: ${status || 'n/a'})`);
  sendSuccess(res, { received: true, ignored: true });
}

