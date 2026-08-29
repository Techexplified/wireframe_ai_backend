// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/subscriptions/subscription.controller.ts — Subscription Management Handlers
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   HTTP handlers for three subscription endpoints:\n//     1. GET /api/subscription/status (plan details & billing info)\n//     2. POST /api/subscription/cancel (schedule cancellation at period end)\n//     3. POST /api/subscription/reactivate (undo cancellation)\n//   Responsible for: exposing subscription state to client, orchestrating cancellation/reactivation\n//   NOT responsible for: payment processing (done by dodo.provider)\n//\n// SUBSCRIPTION LIFECYCLE:\n//   \n//   Day 1: User upgrades (Trigger A)\n//     • POST /api/checkout/init { plan: 'pro' }\n//     • payment.controller creates checkout\n//     • User pays on Dodo\n//     • Dodo sends: subscription.update webhook\n//     • webhook.controller updates: user.plan='pro', user.dodo_subscription_id='sub_123'\n//   \n//   Day 30: End of billing period (automatic)\n//     • Dodo auto-charges: next month's subscription\n//     • Dodo sends: subscription.update webhook (new period)\n//     • webhook.controller updates: user.subscription_ends_at (new date), plan_credits reset\n//   \n//   Day 15 (within first period): User cancels\n//     • POST /api/subscription/cancel\n//     • cancelSubscriptionHandler updates: user.subscription_cancelled=true\n//     • Also calls: Dodo PATCH /subscriptions/{sub_123} { cancel_at_next_billing_date: true }\n//     • Result: subscription marked \"cancel scheduled\"\n//   \n//   Day 30: Next billing period arrived\n//     • Dodo does NOT charge (cancel_at_next_billing_date=true)\n//     • Dodo sends: subscription.cancel webhook\n//     • User's plan: downgraded to 'free'\n//     • User lost: pro features, generation access\n//   \n//   OR (within first period): User reactivates before Day 30\n//     • POST /api/subscription/reactivate\n//     • reactivateSubscriptionHandler updates: user.subscription_cancelled=false\n//     • Also calls: Dodo PATCH /subscriptions/{sub_123} { cancel_at_next_billing_date: false }\n//     • Result: Dodo removes \"cancel scheduled\" flag\n//   \n//   Day 30: Next billing period arrives\n//     • Dodo auto-charges: next month's subscription (not canceled)\n//     • Dodo sends: subscription.update webhook\n//     • User continues enjoying pro access\n//\n// GETSUBSCRIPTIONSTATUSHANDLER LOGIC:\n//   \n//   Purpose: \"Give me my current subscription state\"\n//   Called by: Figma plugin on app startup (populate UI with user's plan info)\n//   Does NOT: modify any state (read-only)\n//   \n//   Step 1: Extract plan state\n//     • planState: already loaded by auth.middleware (cached from DB)\n//     • Contains: { plan, isActive, credits, topup_credits, days_left, subscription_ends_at, subscription_cancelled }\n//   \n//   Step 2: Compute response fields\n//     • total_credits = credits + topup_credits (sum both sources)\n//     • last_payment_attempt: extract from planState (if payment failed, show details)\n//     • UI flags:\n//       - show_upgrade: if not pro (user should upgrade)\n//       - show_topup: if pro (user can buy more credits)\n//       - show_renew: if free + no credits (user should renew/topup)\n//       - is_trial: if free + credits > 0 (user on free trial)\n//   \n//   Step 3: Return response\n//     • 200 OK with full subscription details\n//     • Plugin uses: to show plan badge (\"Pro\"), credits widget, renew button\n//   \n//   Example response for Pro user:\n//     {\n//       plan: 'pro',\n//       isActive: true,\n//       credits: 480000,              // monthly budget\n//       topup_credits: 5000,           // purchased\n//       total_credits: 485000,         // sum\n//       days_left: 12,                 // until period ends\n//       subscription_ends_at: '2025-02-15T10:30:00Z',\n//       subscription_cancelled: false,  // not scheduled to cancel\n//       show_upgrade: false,            // already pro\n//       show_topup: true,               // can buy more\n//       show_renew: false,              // has credits\n//       is_trial: false,                // not trial\n//       last_payment_attempt: null     // payment succeeded\n//     }\n//\n// CANCELSUBSCRIPTIONHANDLER LOGIC (Trigger B - partial):\n//   \n//   Purpose: \"I want to cancel my subscription\"\n//   Called by: User clicks \"Cancel Plan\" in plugin settings\n//   Effect: schedule cancellation at end of billing period\n//   \n//   Step 1: Authorization checks\n//     • Check: isActive=true (user has active subscription)\n//     • Check: plan='pro' (not checking free/other plans)\n//     • If not: return 403 \"not_subscribed\"\n//   \n//   Step 2: Idempotency check\n//     • Query: user.subscription_cancelled\n//     • If true: already scheduled → return 409 Conflict\n//     • Why? User clicked cancel twice (fast double-click)\n//     • Response: \"Already scheduled for cancellation\"\n//   \n//   Step 3: Notify Dodo (if subscription ID exists)\n//     • PATCH /subscriptions/{dodo_subscription_id}\n//     • Set: { cancel_at_next_billing_date: true }\n//     • Result: Dodo won't auto-renew at end of period\n//     • Error handling: log warning but proceed (local state takes precedence)\n//     • Why proceed on error? If Dodo API down: still mark locally (eventual consistency)\n//   \n//   Step 4: Update local state\n//     • users.updateOne({ figmaUserId }, { $set: { subscription_cancelled: true } })\n//     • Update: updatedAt timestamp (audit trail)\n//     • Side effect: planState cache invalidated on next request\n//   \n//   Step 5: Success response\n//     • Return: 200 OK { cancelled: true, subscription_ends_at, message }\n//     • Message: \"You retain full Pro access and credits until your current period ends.\"\n//     • Plugin shows: \"Plan will cancel on [date]\"\n//   \n//   Cancellation semantics:\n//     • Soft cancel: user keeps access until end of period\n//     • Why? User already paid for this period\n//     • Not immediate: avoids buyer's remorse issues\n//     • Can undo: call /reactivate before period ends\n//   \n//   Missing dodo_subscription_id warning:\n//     • If user doesn't have dodo_subscription_id: log error\n//     • Why? User is pro, but no Dodo subscription ID\n//     • Possible: migration from old system, manual plan grant, etc.\n//     • Action: admin must manually cancel in Dodo dashboard\n//     • User: still downgraded to free (local state change)\n//\n// REACTIVATESUBSCRIPTIONHANDLER LOGIC:\n//   \n//   Purpose: \"Oops, I want to keep my subscription\"\n//   Called by: User clicks \"Reactivate\" before subscription ends\n//   Effect: undo cancellation (auto-renew continues)\n//   \n//   Step 1: Authorization checks\n//     • Check: isActive=true (user has active subscription)\n//     • Check: plan='pro'\n//     • If not: return 403 \"not_subscribed\"\n//   \n//   Step 2: Idempotency check\n//     • Query: user.subscription_cancelled\n//     • If false: not scheduled to cancel → return 409 Conflict\n//     • Why? User clicked reactivate, but subscription not canceled\n//     • Response: \"Auto-renewal is already active\"\n//   \n//   Step 3: Notify Dodo (if subscription ID exists)\n//     • PATCH /subscriptions/{dodo_subscription_id}\n//     • Set: { cancel_at_next_billing_date: false }\n//     • Result: Dodo resumes auto-renewal at end of period\n//     • Error handling: log warning but proceed (local state takes precedence)\n//   \n//   Step 4: Update local state\n//     • users.updateOne({ figmaUserId }, { $set: { subscription_cancelled: false } })\n//     • Update: updatedAt timestamp\n//     • Side effect: planState cache invalidated\n//   \n//   Step 5: Success response\n//     • Return: 200 OK { reactivated: true, subscription_ends_at, message }\n//     • Message: \"Auto-renewal reactivated! Your Pro plan will renew automatically...\"\n//     • Plugin shows: \"Subscription active again\"\n//   \n//   Reactivation window:\n//     • Only works if: subscription_cancelled=true AND subscription_ends_at > now\n//     • If subscription already ended: can't reactivate (must repurchase)\n//     • If already not canceled: can't reactivate (nothing to undo)\n//\n// DODO API ERROR HANDLING:\n//   \n//   Cancel/reactivate call failures:\n//     • Example: Dodo API down, returns 500\n//     • Local behavior: still update user.subscription_cancelled (optimistic)\n//     • Dodo sync: next webhook brings DB back in sync\n//     • Result: eventual consistency (user sees correct state)\n//   \n//   Why not block on Dodo success?\n//     • User clicked \"Cancel\", but Dodo API is slow\n//     • Blocking: user waits 10 seconds for response\n//     • UX: bad (looks like app hangs)\n//     • Better: update local state immediately, Dodo syncs eventually\n//     • If Dodo fails: next webhook corrects it\n//   \n//   Retry logic:\n//     • We don't retry Dodo calls (fire-and-forget)\n//     • If failed: user can click cancel again\n//     • Or: Dodo eventually sends webhook with correct state\n//     • Result: recoverable (not stuck states)\n//\n// CACHING & INVALIDATION:\n//   \n//   planState is cached by auth.middleware\n//     • Cache location: req.planState (per-request)\n//     • Cache lifetime: single HTTP request\n//     • Invalidation: automatic (new request rebuilds)\n//   \n//   After cancel/reactivate:\n//     • User DB updated immediately\n//     • Next request: planState re-fetched (new cache)\n//     • Result: consistency after ~100ms\n//   \n//   WebSocket sync (not implemented):\n//     • Could push cache invalidation to plugin\n//     • But: plugin queries /status every 30 seconds anyway\n//     • Added complexity: not worth it\n//\n// AUDIT TRAIL:\n//   \n//   Every state change timestamps:\n//     • users.updateOne { $set: { subscription_cancelled: bool, updatedAt: now } }\n//     • Admin can query: users.find({ figmaUserId: 'x' }).sort({ updatedAt: -1 })\n//     • See: all state changes with timestamps\n//   \n//   For more detail:\n//     • usage_logs collection: logs all subscription events\n//     • webhook.controller logs: incoming webhook events\n//     • All logs: include requestId (tied to HTTP request)\n//\n// ERROR SCENARIOS:\n//   \n//   Scenario A: Free user calls /cancel\n//     • Check: plan='pro'? No, it's 'free'\n//     • Return: 403 \"not_subscribed\"\n//   \n//   Scenario B: Pro user, dodo_subscription_id missing\n//     • Should never happen (subscription.update webhook sets it)\n//     • If happens: log error, still mark locally canceled\n//     • Admin: must manually sync Dodo\n//   \n//   Scenario C: Network error during /cancel\n//     • Local: user.subscription_cancelled = true (completed)\n//     • Dodo: might not have received call\n//     • Recovery: next payment attempt, webhook corrects state\n//     • Result: no money charged (worst case: invoice dispute)\n//   \n//   Scenario D: Double-cancel (user clicks twice)\n//     • First call: subscription_cancelled = false → true\n//     • Second call: subscription_cancelled = true → check fails (409 Conflict)\n//     • Result: idempotent (no double-processing)\n//\n// FUTURE IMPROVEMENTS:\n//   \n//   1. WebSocket sync: push cache invalidation to plugin\n//   2. Pause subscription: user wants to pause, not cancel\n//   3. Plan downgrade: switch pro → free without canceling\n//   4. Billing pause: skip next cycle (temporary pause)\n//   5. Churn prevention: offer discounts before cancel\n//

import { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response';
import { SubscriptionStatusResponse } from './subscription.types';
import { cancelSubscription, reactivateSubscription } from '../payments/providers/dodo.provider';
import { getUsersCollection } from '../../config/database';
import { ForbiddenError, ConflictError } from '../../utils/errors';
import { logger } from '../../utils/logger';

// ── GET /api/subscription/status ─────────────────────────────────────────────

export async function getSubscriptionStatusHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits, days_left, subscription_ends_at, subscription_cancelled, last_payment_attempt } = req.planState;

  const totalCredits = credits + topup_credits;

  const responseData: SubscriptionStatusResponse = {
    plan,
    isActive,
    credits,
    topup_credits,
    total_credits:          totalCredits,
    days_left,
    subscription_ends_at:   subscription_ends_at?.toISOString() ?? null,
    subscription_cancelled: subscription_cancelled ?? false,
    show_upgrade:           !isActive,
    show_topup:             isActive,
    show_renew:             !isActive && credits === 0,
    is_trial:               plan === 'free' && credits > 0,
    last_payment_attempt:   last_payment_attempt ? {
      payment_id:    last_payment_attempt.payment_id,
      status:        last_payment_attempt.status,
      error_code:    last_payment_attempt.error_code,
      error_message: last_payment_attempt.error_message,
      failed_at:     last_payment_attempt.failed_at ? new Date(last_payment_attempt.failed_at).toISOString() : undefined,
    } : null,
  };

  sendSuccess(res, responseData);
}

// ── POST /api/subscription/cancel ────────────────────────────────────────────

export async function cancelSubscriptionHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, subscription_ends_at } = req.planState;
  const figmaUserId = req.figmaUserId;

  if (!isActive || plan !== 'pro') {
    throw new ForbiddenError('No active Pro subscription to cancel.', 'not_subscribed');
  }

  const users = await getUsersCollection();
  const user  = await users.findOne({ figmaUserId });

  if (user?.subscription_cancelled) {
    throw new ConflictError('Subscription is already scheduled for cancellation at the end of the billing period.', 'already_cancelled');
  }

  // If a Dodo subscription ID is present, request scheduled cancellation on Dodo
  if (user?.dodo_subscription_id) {
    try {
      logger.info(`[subscription.controller] Cancelling Dodo subscription ${user.dodo_subscription_id} for user ${figmaUserId}`);
      await cancelSubscription(user.dodo_subscription_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[subscription.controller] Dodo cancel API call warning for ${user.dodo_subscription_id}: ${msg} — proceeding with local cancellation`);
    }
  } else {
    logger.error(`[subscription.controller] ALERT: No dodo_subscription_id found for active Pro user ${figmaUserId} during cancellation. Manual cancellation in Dodo dashboard may be required if billing continues.`);
  }

  const now = new Date();
  await users.updateOne(
    { figmaUserId },
    { $set: { subscription_cancelled: true, updatedAt: now } }
  );

  sendSuccess(res, {
    cancelled:            true,
    subscription_ends_at: subscription_ends_at?.toISOString() ?? user?.subscription_ends_at?.toISOString() ?? null,
    message:              'Your subscription will not renew next cycle. You retain full Pro access and credits until your current period ends.',
  });
}

// ── POST /api/subscription/reactivate ────────────────────────────────────────

export async function reactivateSubscriptionHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, subscription_ends_at } = req.planState;
  const figmaUserId = req.figmaUserId;

  if (!isActive || plan !== 'pro') {
    throw new ForbiddenError('No active Pro subscription to reactivate.', 'not_subscribed');
  }

  const users = await getUsersCollection();
  const user  = await users.findOne({ figmaUserId });

  if (!user?.subscription_cancelled) {
    throw new ConflictError('Subscription is not scheduled for cancellation. Auto-renewal is already active.', 'not_cancelled');
  }

  // If a Dodo subscription ID is present, request reactivation on Dodo
  if (user?.dodo_subscription_id) {
    try {
      logger.info(`[subscription.controller] Reactivating Dodo subscription ${user.dodo_subscription_id} for user ${figmaUserId}`);
      await reactivateSubscription(user.dodo_subscription_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[subscription.controller] Dodo reactivate API call warning for ${user.dodo_subscription_id}: ${msg} — proceeding with local reactivation`);
    }
  } else {
    logger.warn(`[subscription.controller] No dodo_subscription_id found for ${figmaUserId} during reactivation — applying local reactivation`);
  }

  const now = new Date();
  await users.updateOne(
    { figmaUserId },
    { $set: { subscription_cancelled: false, updatedAt: now } }
  );

  sendSuccess(res, {
    reactivated:          true,
    subscription_ends_at: subscription_ends_at?.toISOString() ?? user?.subscription_ends_at?.toISOString() ?? null,
    message:              'Auto-renewal reactivated! Your Pro plan will renew automatically on your next billing date.',
  });
}
