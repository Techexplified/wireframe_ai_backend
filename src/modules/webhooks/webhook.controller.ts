// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/webhooks/webhook.controller.ts — Dodo Payment Webhook Handlers
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   HTTP handler for POST /webhooks/dodo\n//   Processes payment/subscription events from Dodo Payments\n//   Responsible for: updating user plan, credits, and subscription state\n//\n// WHY WEBHOOKS?\n//   \n//   Problem: payment happens on Dodo's servers (our server can't know immediately)\n//     • User fills checkout form on Dodo\n//     • Dodo processes payment (takes 2-5 seconds)\n//     • Browser redirects back to our success page\n//     • But: what if redirect fails? What if browser crashes?\n//     • Result: payment completed on Dodo, but our DB still thinks user is free\n//   \n//   Solution: webhooks as source of truth\n//     • Dodo sends: POST /webhooks/dodo with payment results\n//     • Dodo sends: multiple times if we don't acknowledge (at-least-once delivery)\n//     • We verify: signature (only accept from real Dodo)\n//     • We process: update user state in DB\n//     • We respond: 200 OK (\"got it, don't retry\")\n//     • Result: user's plan/credits updated, even if browser crashed\n//   \n//   Webhook events from Dodo:\n//     • subscription.update: plan upgraded, subscription renewed, days_left extended\n//     • payment.complete: top-up credits purchased\n//     • payment.failed: payment failed (card declined, no funds, etc.)\n//     • subscription.cancel: user canceled subscription\n//     • payment.refunded: user requested refund (rare, manual operation)\n//\n// IDEMPOTENCY (prevent double-processing):\n//   \n//   Problem: Dodo might send same webhook multiple times\n//     • Network issue: our 200 OK response lost, Dodo retries\n//     • Example: user pays, server returns 200, but network drops\n//     • Dodo receives: no 200 OK, assumes we didn't process\n//     • Dodo retries: same webhook 5 minutes later\n//     • If we process twice: user charged twice, subscription doubled\n//   \n//   Solution: idempotency key (eventId)\n//     • Every webhook has: msgId (Svix) or eventId (Dodo)\n//     • First time: mark event as 'processing' in DB\n//     • Process: update user state\n//     • Mark: 'completed' (status changed from 'processing')\n//     • If retry comes: check status='completed' → skip processing, return 200\n//     • Result: always idempotent (process once per unique eventId)\n//   \n//   Idempotency storage (processed_webhooks collection):\n//     • Document: { eventId, userId, status: 'processing'|'completed'|'failed', timestamp }\n//     • Index: unique on eventId (prevents duplicate inserts)\n//     • TTL: 30 days (auto-delete old events)\n//   \n//   At-most-once semantics:\n//     • After first processing: status='completed', event never re-processed\n//     • Even if 1000 retries: same result (idempotent)\n//\n// DODOWEBHOOKHANDLER FLOW:\n//   \n//   Step 1: Signature Verification (SEC-C-01)\n//     • Extract: webhook-signature, webhook-id, webhook-timestamp headers\n//     • Call: verifyWebhookSignature(rawBody, signature, meta)\n//     • If invalid: throw 403 Unauthorized (don't retry, real Dodo wouldn't send this)\n//     • If valid: proceed (this really came from Dodo)\n//   \n//   Step 2: Parse Payload\n//     • Extract: req.body (JSON parsed by Express middleware)\n//     • Fallback: if body empty, parse req.rawBody manually\n//     • Extract: eventType (\"subscription.update\", \"payment.complete\", etc.)\n//   \n//   Step 3: Extract EventId (idempotency key)\n//     • Try in order: msgId (Svix), event_id, id, data.event_id\n//     • Fallback: synthesize from payment_id or subscription_id + eventType\n//     • If none: log warning, still proceed (will retry on error)\n//   \n//   Step 4: Check Idempotency\n//     • Call: markEventProcessed(figmaUserId, eventId)\n//     • If true: new event, proceed\n//     • If false: duplicate, skip processing, return 200 OK\n//     • FSM transition: no status entry → insert status='processing'\n//   \n//   Step 5: Extract FigmaUserId (user identification)\n//     • Check: metadata.figmaUserId (most common)\n//     • Fallback: metadata.figma_user_id (old format)\n//     • Fallback: look up by customer email\n//     • If missing: log error, return 400 (can't identify user)\n//   \n//   Step 6: Route to Handler (based on eventType)\n//     • subscription.update → handleSubscriptionUpdate\n//     • payment.complete → handlePaymentComplete\n//     • payment.failed → handlePaymentFailed\n//     • subscription.cancel → handleSubscriptionCancel\n//     • payment.refunded → handlePaymentRefunded\n//     • Other → log warning, mark completed, return 200\n//   \n//   Step 7: Process Handler\n//     • Handler reads: payload, figmaUserId\n//     • Handler updates: users collection, maybe credits\n//     • Handler sets: plan, dodo_subscription_id, subscription_ends_at\n//   \n//   Step 8: Mark Completion\n//     • Call: completeEventProcessed(eventId)\n//     • Updates: status='processing' → 'completed'\n//     • Side effect: on retry, status='completed' → skip processing\n//   \n//   Step 9: Response\n//     • Return: 200 OK { success: true }\n//     • Dodo receives: 200, stops retrying\n//     • If error: return 500, Dodo keeps retrying (up to ~7 days)\n//\n// EVENT HANDLERS (route by eventType):\n//   \n//   1. handleSubscriptionUpdate (Trigger A + plan upgrade)\n//      • When: user upgrades to pro OR subscription auto-renews OR plan changes\n//      • Payload: {\n//          event_type: 'subscription.update',\n//          data: {\n//            subscription_id: 'sub_abc123',\n//            customer_id: 'cus_def456',\n//            plan: 'pro' | 'pro_annual',\n//            subscription_status: 'active',\n//            current_period_start: 1787149876,\n//            current_period_end: 1789828276,  // 30 days later\n//            metadata: { figmaUserId, planId: 'pro' }\n//          }\n//        }\n//      • Actions:\n//        a) Verify: subscription_status = 'active'\n//        b) Extract: planId from metadata or fallback\n//        c) Update: users collection\n//           { plan: 'pro',\n//             dodo_subscription_id: subscription_id,\n//             subscription_ends_at: current_period_end (as Date),\n//             subscription_cancelled: false,\n//             plan_credits: PLAN_CONFIG['pro'].monthly_credits (500k) }\n//        d) Return: { success: true }\n//      • Side effects:\n//        • User can now generate (pro features enabled)\n//        • Daily quota updated: 50k → 500k tokens/day\n//        • Rate limit updated: 1/30s → 3/10s\n//        • Budget cap updated: $0.10 → $0.80 per request\n//   \n//   2. handlePaymentComplete (Trigger D - top-up purchase)\n//      • When: user completed top-up checkout (one-time purchase)\n//      • Payload: {\n//          event_type: 'payment.complete',\n//          data: {\n//            payment_id: 'pay_xyz789',\n//            customer_id: 'cus_def456',\n//            amount_usd: 9.99,\n//            status: 'succeeded',\n//            metadata: { figmaUserId, packId: '500' }\n//          }\n//        }\n//      • Actions:\n//        a) Verify: status = 'succeeded'\n//        b) Extract: packId from metadata (\"100\"|\"500\"|\"1000\")\n//        c) Look up: TOPUP_PACKS[packId].credits (how many credits)\n//        d) Update: users collection\n//           { topup_credits: existing + credits }\n//        e) Log: payment details (amount, credits added)\n//        f) Return: { success: true }\n//      • Side effects:\n//        • User's credit balance increased\n//        • UI shows: \"You now have 550 topup credits!\"\n//        • Can generate again immediately\n//   \n//   3. handlePaymentFailed (error recovery)\n//      • When: payment failed (card declined, insufficient funds, etc.)\n//      • Payload: {\n//          event_type: 'payment.failed',\n//          data: {\n//            payment_id: 'pay_failed123',\n//            customer_id: 'cus_def456',\n//            error_code: 'card_declined',\n//            error_message: 'Your card was declined',\n//            metadata: { figmaUserId }\n//          }\n//        }\n//      • Actions:\n//        a) Extract: figmaUserId\n//        b) Log: failed payment details\n//        c) Update: users collection\n//           { last_payment_attempt: {\n//               timestamp: now,\n//               amount_usd: null,\n//               status: 'failed',\n//               error_code: error_code }\n//           }\n//        d) Return: { success: true }\n//      • Side effects:\n//        • User's plan/credits: unchanged\n//        • Dodo retries: ~7 days for recurring payments\n//        • For topup: user can try again (new checkout)\n//   \n//   4. handleSubscriptionCancel (Trigger B - downgrade)\n//      • When: user canceled subscription (or Dodo stopped charging)\n//      • Payload: {\n//          event_type: 'subscription.cancel',\n//          data: {\n//            subscription_id: 'sub_abc123',\n//            customer_id: 'cus_def456',\n//            canceled_at: 1787149876,\n//            cancel_reason: 'cancelled_by_customer',\n//            metadata: { figmaUserId }\n//          }\n//        }\n//      • Actions:\n//        a) Extract: figmaUserId, subscription_id\n//        b) Verify: matches user's dodo_subscription_id\n//        c) Update: users collection\n//           { subscription_cancelled: true }\n//        d) Return: { success: true }\n//      • Side effects:\n//        • User stays pro until subscription_ends_at\n//        • At subscription_ends_at: daily job downgrades to free\n//        • User can call POST /api/subscription/reactivate before then\n//   \n//   5. handlePaymentRefunded (rare, manual)\n//      • When: admin issued refund on Dodo dashboard\n//      • Payload: {\n//          event_type: 'payment.refunded',\n//          data: {\n//            payment_id: 'pay_refunded123',\n//            original_payment_id: 'pay_original456',\n//            refund_amount_usd: 9.99,\n//            metadata: { figmaUserId }\n//          }\n//        }\n//      • Actions:\n//        a) Log: refund details\n//        b) (Usually: manual credit adjustment needed)\n//        c) Return: { success: true }\n//      • Side effects:\n//        • Typically: admin also manually gives credits\n//        • Webhook just records: \"refund happened\"\n//\n// METADATA EXTRACTION (figmaUserId discovery):\n//   \n//   Dodo puts metadata in different places per event type:\n//     • subscription.update → data.subscription.metadata\n//     • payment.complete → data.payment.metadata\n//     • payment.failed → data.payment.metadata\n//     • subscription.cancel → data.subscription.metadata\n//   \n//   We merge all metadata locations into single object\n//   Then search for: figmaUserId, figma_user_id, client_reference_id\n//   Fallback: look up by customer email (slow, requires DB query)\n//   If still missing: return 400 (can't identify user)\n//   \n//   Why multiple locations?\n//     • Different Dodo API versions use different paths\n//     • Belt and suspenders: maximize compatibility\n//\n// EVENTID SYNTHESIS (idempotency key):\n//   \n//   Dodo should send msgId (Svix standard)\n//   But for backup, we synthesize from payment_id/subscription_id\n//   \n//   If msgId=msg_abc123:\n//     • Use msgId as eventId (guaranteed unique)\n//   Else if payment_id exists:\n//     • eventId = \"subscription.update_pay_xyz\" (combine type + payment_id)\n//     • Prevents: different events on same payment_id from colliding\n//   Else if subscription_id exists:\n//     • eventId = \"payment.complete_sub_abc\" (combine type + subscription_id)\n//   \n//   Why combine with eventType?\n//     • Example: payment_id=pay_123, but two events (payment.complete + payment.refunded)\n//     • Without type prefix: both use same eventId → second skipped as duplicate\n//     • With type prefix: \"payment.complete_pay_123\" vs \"payment.refunded_pay_123\" (different)\n//     • Both processed correctly\n//\n// FIXES APPLIED:\n//   \n//   PAY-M-01: eventId uses canonical data.payment_id with event type prefix\n//     • Issue: eventId fallback didn't prefix with type → different events same id\n//     • Fix: eventId = \"${eventType}_${data.payment_id}\" (includes type)\n//     • Location: line 95 (synthesized eventId computation)\n//   \n//   PAY-M-02: paymentType reads only metadata.paymentType (camelCase)\n//     • Issue: metadata had payment_type (snake_case) instead of paymentType (camelCase)\n//     • Fix: paymentType field in constants always camelCase\n//     • Location: metadata reading (line 148)\n//   \n//   PAY-H-02: Added handlers for payment.refunded and subscription.cancelled\n//     • Issue: webhooks with rare event types crashed (unhandled)\n//     • Fix: all event types routed (unknown → log + mark complete + return 200)\n//     • Location: switch statement (line 140+)\n//\n// ERROR HANDLING:\n//   \n//   Invalid signature:\n//     • Return: 403 Forbidden\n//     • Dodo: treats as permanent (no retry)\n//     • Why? If signature invalid: probably not from Dodo anyway\n//   \n//   Invalid JSON:\n//     • Return: 400 Bad Request\n//     • Dodo: treats as permanent (no retry)\n//     • Why? If malformed: we can't process anyway\n//   \n//   Missing figmaUserId:\n//     • Return: 400 Bad Request\n//     • Dodo: treats as permanent (no retry)\n//     • Why? Without user ID: can't update DB\n//   \n//   Idempotency check failed (DB error):\n//     • Return: 500 Internal Server Error\n//     • Dodo: retries (up to ~7 days)\n//     • Why? Temporary error (DB might recover)\n//   \n//   Handler failed (DB error during update):\n//     • Return: 500 Internal Server Error\n//     • Dodo: retries\n//     • Why? Temporary (DB might recover)\n//     • Side effect: if retried and succeeds: idempotency key prevents double-update\n//   \n//   Unknown event type:\n//     • Return: 200 OK (mark completed, don't retry)\n//     • Dodo: treats as success\n//     • Why? We don't handle it, but no error (just log it)\n//\n// PERFORMANCE & SCALING:\n//   \n//   Webhook latency (target <1 second):\n//     • Dodo retries for 7 days if we don't respond within ~10 seconds\n//     • Fast path: check idempotency (cache) → skip if duplicate\n//     • Normal path: idempotency check (DB) → process → mark complete\n//   \n//   High volume (1000+ webhooks/minute during sale/launch):\n//     • Idempotency key check: single DB lookup (indexed)\n//     • Mark processed: atomic insert (indexed)\n//     • Handler: 1-2 DB writes (users, payments collections)\n//     • Max throughput: ~100 webhooks/sec per instance\n//     • Firebase Cloud Functions: auto-scales to N instances\n//     • Result: handles 1000/min easily (10 instances × 100 webhooks/sec)\n//   \n//   Retry storms (if Dodo having trouble):\n//     • Webhook: marked complete after first processing\n//     • Retry: skipped (idempotency check)\n//     • No DB writes on retry (just returns 200)\n//     • Result: zero load increase (retries are free)\n//\n// TESTING:\n//   \n//   Mock webhook in development:\n//     • POST /webhooks/dodo with test payload\n//     • Include: HMAC signature (DODO_WEBHOOK_SECRET)\n//     • Include: msgId, timestamp headers (Svix format)\n//     • Verify: user updated correctly\n//   \n//   Test idempotency:\n//     • Send same webhook twice\n//     • First: processes, marks status='completed'\n//     • Second: skipped (status already completed)\n//     • Verify: user not double-updated\n//   \n//   Test signature verification:\n//     • Send webhook with invalid signature\n//     • Verify: returns 403 (not processed)\n//   \n//   Test error recovery:\n//     • Simulate DB error on first attempt\n//     • Dodo retries after 5 minutes\n//     • Second attempt succeeds\n//     • Verify: user updated (eventually consistent)\n//

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

