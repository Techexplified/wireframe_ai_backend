// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/users/user.service.ts — User Lifecycle & Plan State Management
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   Single source of truth for user plan state\n//   Manages: user creation, plan activation, plan expiration, credit logic\n//   Called by: auth.middleware (on every request), webhook.controller (on payment events)\n//   Implements: Shared Guard pattern for consistent authorization across routes\n//\n// SHARED GUARD PATTERN:\n//   \n//   What is it?\n//     • Every authenticated HTTP request calls getActivePlanState\n//     • Returns: current user's plan, credits, subscription status\n//     • Used by: all routes to decide what user can do\n//     • Ensures: consistent authorization (no route has different view of plan)\n//   \n//   Why this matters:\n//     • Problem: subscription expired, but user still in cache → \"pro for free\"\n//     • Solution: getActivePlanState on every request (checks current time)\n//     • Result: if subscription_ends_at < now, auto-downgrade to free\n//     • No manual cleanup jobs needed (evaluated on-demand)\n//   \n//   Call sites:\n//     • auth.middleware: calls getActivePlanState after JWT verification\n//     • Returns: req.planState (used by all downstream routes)\n//     • Effect: req.planState always reflects current plan state\n//\n// KEY CONCEPTS:\n//   \n//   Plan = subscription tier: 'free' | 'pro'\n//     • Free: 0 credits/month, limited features\n//     • Pro: 500k credits/month + auto-renewal\n//   \n//   Credits = monthly allocation: only pro users get these\n//     • Set on subscription activation (500k for pro)\n//     • Reset monthly (auto via webhook on subscription.update)\n//     • Expire at end of month (not carried forward)\n//   \n//   Topup_Credits = purchased credits: any user can buy these\n//     • Never expire (persist indefinitely, BUG-H-03 fix)\n//     • Deducted after plan_credits (use free allocation first)\n//     • Can buy more at any time\n//   \n//   Subscription_Ends_At = plan expiration date\n//     • Set when plan activated (now + 30 days)\n//     • Updated on each renewal (webhook sets new date)\n//     • If < now: plan expired → runOnceExpire downgrades to free\n//   \n//   Dodo_Subscription_Id = Dodo's internal subscription ID\n//     • Set by: subscription.update webhook\n//     • Used by: POST /cancel and /reactivate endpoints\n//     • For managing: subscription renewal and cancellation\n//\n// GETACTIVEPLANSTATE FLOW (THE SHARED GUARD):\n//   \n//   Step 1: Load or create user\n//     • Query: users.findOne({ figmaUserId })\n//     • If not found: call findOrCreate (new user)\n//     • New user gets: plan='free', credits=FREE_TRIAL_CREDITS (50k), topup=0\n//   \n//   Step 2: Expiry check (one-way door)\n//     • Check: plan !== 'free' AND subscription_ends_at < now\n//     • If true: call runOnceExpire (downgrades to free)\n//     • Effect: irreversible (user must pay again to reactivate)\n//     • Timing: runs on-demand (next HTTP request after expiry)\n//   \n//   Step 3: Free trial cap check\n//     • Check: plan === 'free' AND credits > FREE_TRIAL_CREDITS\n//     • If true: cap credits at FREE_TRIAL_CREDITS (shouldn't happen, but safety)\n//     • Reason: prevent credit inflation via bug\n//   \n//   Step 4: Compute planState (user's view of their subscription)\n//     • Extract: all relevant fields from user doc\n//     • Compute: days_left (from subscription_ends_at)\n//     • Compute: last_payment_attempt (with 5-minute window)\n//     • Return: planState object (used by all routes)\n//   \n//   Output:\n//     • { user, planState }\n//     • user: full MongoDB document (for detailed operations)\n//     • planState: simplified view (for authorization)\n//   \n//   Why called on every request?\n//     • Fix ②: subscription expiry must be checked on every request\n//     • Example: user pro until Jan 31 11:59 PM\n//       - Jan 31 10:00 PM: /generate → plan='pro' (still active)\n//       - Feb 1 00:00 AM: /generate → plan='free' (just expired)\n//     • Without check: user wouldn't know plan expired until next login\n//\n// FINDORCREATE LOGIC:\n//   \n//   Purpose: atomically create user if doesn't exist\n//   Input: figmaUserId, name (optional)\n//   Output: created or existing user\n//   \n//   Atomic operation:\n//     • MongoDB upsert: $setOnInsert (only if inserting)\n//     • $set: always apply (name update)\n//     • Result: exactly one document with figmaUserId\n//   \n//   New user fields:\n//     • plan: 'free' (must be free, no subscription)\n//     • credits: FREE_TRIAL_CREDITS (50k, one-time grant, Fix ⑧)\n//     • topup_credits: 0 (no purchases yet)\n//     • subscription_started_at: null (no subscription)\n//     • subscription_ends_at: null (no expiry)\n//     • dodo_subscription_id: null (not linked to Dodo)\n//     • createdAt: now (audit trail)\n//   \n//   Why upsert?\n//     • Problem: concurrent requests from same user\n//     • Example: two HTTP requests, same figmaUserId, arrive simultaneously\n//     • Old approach: both see no user, both insert → duplicate\n//     • Upsert: only one insert succeeds, both see same user\n//     • Result: idempotent (no duplicates)\n//   \n//   Fix ⑧: trial credits granted once\n//     • $setOnInsert: only applied on first creation\n//     • Subsequent calls: $set only (don't re-grant credits)\n//     • Result: user gets 50k credits once, not every request\n//\n// RUNONCEEXPIRE LOGIC (one-way door):\n//   \n//   Purpose: downgrade expired pro to free\n//   Called when: subscription_ends_at < now\n//   Effect: irreversible (user must repurchase)\n//   \n//   Downgrade fields:\n//     • plan: 'free' (no longer pro)\n//     • credits: 0 (monthly allocation gone)\n//     • topup_credits: KEPT (BUG-H-03 fix: don't expire topup)\n//     • subscription_ended_at: null (clear expiry)\n//     • subscription_started_at: null (clear start)\n//     • subscription_cancelled: false (reset flag)\n//     • dodo_subscription_id: null (un-link from Dodo)\n//   \n//   Why topup_credits kept?\n//     • BUG-H-03 fix: topup credits never expire\n//     • User paid for these: should keep them\n//     • Plan credits: monthly allocation (can't carry forward)\n//     • Topup credits: one-time purchase (keep indefinitely)\n//     • Result: user keeps purchased credits even after plan expires\n//   \n//   When called:\n//     • getActivePlanState: automatic on next request after expiry\n//     • expirePass: manual (for testing or admin)\n//     • Idempotent: safe to call multiple times\n//   \n//   No re-grant logic:\n//     • Old plan: 500k credits (now gone)\n//     • If subscription renewed: new webhook grants new 500k\n//     • No auto-refill (must pay to re-activate)\n//\n// ACTIVATEPLAN LOGIC (called by webhook on subscription.update):\n//   \n//   Purpose: grant user pro access + credits\n//   Input: figmaUserId, planId, dodoSubscriptionId (optional)\n//   Called by: webhook.controller on subscription.update webhook\n//   \n//   Precondition: user must pre-exist (ghost user guard)\n//     • Query: users.findOne({ figmaUserId })\n//     • If not found: throw error (don't upsert)\n//     • Why? Prevent malicious webhook from creating fake users\n//   \n//   Activation fields:\n//     • plan: 'pro' (upgrade to pro)\n//     • credits: config.credits (500k for pro)\n//     • subscription_started_at: now (audit trail)\n//     • subscription_ends_at: now + 30 days (expiry)\n//     • subscription_cancelled: false (active auto-renewal)\n//     • dodo_subscription_id: from webhook (link to Dodo)\n//   \n//   Topup_credits: UNCHANGED\n//     • Reason: mid-cycle upgrade shouldn't lose purchased credits\n//     • Example: user has 5k topup, upgrades → still has 5k topup\n//   \n//   Mid-cycle upgrade rule:\n//     • Old pass: 10 days left, 50k credits (forfeited)\n//     • New pass: 30 days, 500k credits (fresh start)\n//     • Old credits: lost (not prorated, one-time pass model)\n//     • Why? Prevents: \"buy on day 29, get 29 days at no extra cost\"\n//   \n//   Ghost user guard:\n//     • Before: webhook could create new users via upsert\n//     • Problem: malicious webhook with random figmaUserId\n//     • Fix: activatePlan requires user to pre-exist\n//     • Result: only real users (who logged in) can activate\n//   \n//   Error handling:\n//     • If user not found: log error + throw\n//     • Webhook handler: catches error, returns 500 (Dodo retries)\n//     • Next retry: might succeed if user logs in and creates account\n//\n// REVOKEFAILEDPAYMENTPASS LOGIC:\n//   \n//   Purpose: revoke unearned pro access (payment failed)\n//   Scenario: webhook says \"payment failed\" after giving pro access\n//   \n//   Example flow:\n//     1. User clicks \"Upgrade to Pro\"\n//     2. Dodo sends: subscription.update (user now pro)\n//     3. webhook.controller: calls activatePlan (user gets pro)\n//     4. Dodo sends: payment.failed (card declined)\n//     5. webhook.controller: calls revokeFailedPaymentPass\n//     6. Result: user downgraded to free, trial credits restored\n//   \n//   Downgrade logic:\n//     • plan: 'free' (no longer pro)\n//     • credits: restoreToTrialCredits (50k, not 0)\n//     • Why not 0? Prevent: \"payment failed, now have no credits at all\"\n//     • Restore formula:\n//       - If user had lots of credits: restore to FREE_TRIAL_CREDITS (50k)\n//       - If user had few credits: keep what they had (min 0)\n//       - Example: user had 10k before upgrade, payment fails\n//         → restore to max(10k, FREE_TRIAL_CREDITS) = 50k\n//   \n//   Result: user not punished for payment failure\n//\n// EXPIREPASS PUBLIC ALIAS:\n//   \n//   Export: expirePass = runOnceExpire\n//   Purpose: public API for manual expiration\n//   Used by: admin tools, test cleanup, emergency downgrades\n//\n// USER SCHEMA (UserDoc):\n//   \n//   {\n//     figmaUserId: string,                    // Figma user ID (primary key)\n//     name?: string,                          // User's display name\n//     plan: 'free' | 'pro',                   // Current plan\n//     credits: number,                        // Monthly allocation (plan_credits)\n//     topup_credits: number,                  // Purchased credits (non-expiring)\n//     subscription_started_at?: Date | null,  // When plan activated\n//     subscription_ends_at?: Date | null,     // When plan expires\n//     subscription_cancelled?: boolean,       // Scheduled to cancel at period end?\n//     dodo_subscription_id?: string | null,   // Dodo's subscription ID\n//     last_payment_attempt?: {\n//       payment_id?: string,\n//       status: 'failed' | 'succeeded',\n//       error_code?: string,\n//       error_message?: string,\n//       failed_at?: Date,\n//     },\n//     firebaseUid?: string,                   // Firebase UID (for auth binding)\n//     createdAt: Date,                        // When user created\n//     updatedAt: Date,                        // Last modification\n//   }\n//\n// PLANSTATE SCHEMA (computed view for routes):\n//   \n//   {\n//     plan: 'free' | 'pro',                   // Current plan\n//     isActive: boolean,                      // plan !== 'free'\n//     credits: number,                        // Monthly allocation\n//     topup_credits: number,                  // Purchased credits\n//     days_left: number,                      // Until subscription_ends_at\n//     subscription_ends_at: Date | null,      // Expiry date\n//     subscription_cancelled: boolean,        // Cancel scheduled?\n//     dodo_subscription_id: string | null,    // Dodo ID (for cancel/reactivate)\n//     last_payment_attempt: object | null,    // Last payment result (5-min window)\n//   }\n//\n// AUTHORIZATION FLOW (all routes):\n//   \n//   1. Firebase JWT → auth.middleware\n//   2. auth.middleware → getActivePlanState(figmaUserId)\n//   3. req.planState ← response\n//   4. All downstream routes → use req.planState for authorization\n//   5. Examples:\n//      - /generate → check: planState.isActive (pro required)\n//      - /subscription/cancel → check: planState.plan === 'pro'\n//      - /checkout/topup → check: planState.isActive\n//\n// RACE CONDITION HANDLING:\n//   \n//   Scenario: two concurrent requests, same user, both call getActivePlanState\n//   \n//   Old approach (without upsert):\n//     • Request 1: findOne → no user → insert user (credits=50k)\n//     • Request 2: findOne → no user → insert user (credits=50k)\n//     • Result: two users created (duplicate)\n//   \n//   Current approach (with upsert):\n//     • Request 1: findOneAndUpdate(upsert: true) → insert user (credits=50k)\n//     • Request 2: findOneAndUpdate(upsert: true) → already exists, return\n//     • Result: one user, both requests see same credits\n//   \n//   Result: eventually consistent (both requests see correct user)\n//\n// TESTING SCENARIOS:\n//   \n//   Test 1: New user\n//     • No user in DB\n//     • getActivePlanState → creates user with FREE_TRIAL_CREDITS\n//     • Result: { plan: 'free', credits: 50000, isActive: false }\n//   \n//   Test 2: Pro user still active\n//     • subscription_ends_at = tomorrow\n//     • getActivePlanState → no expiry check triggered\n//     • Result: { plan: 'pro', credits: 500000, isActive: true }\n//   \n//   Test 3: Pro user just expired\n//     • subscription_ends_at = yesterday\n//     • getActivePlanState → triggers runOnceExpire\n//     • Result: { plan: 'free', credits: 0, topup: 5000 (kept) }\n//   \n//   Test 4: Payment failed → revoke pro\n//     • User pro with 500k credits\n//     • revokeFailedPaymentPass → downgrade\n//     • Result: { plan: 'free', credits: 50000, isActive: false }\n//\n// FIXES APPLIED:\n//   \n//   Fix ①: getActivePlanState runs expiry check on EVERY request\n//     • Issue: user stayed pro indefinitely (expiry not checked)\n//     • Fix: added expiry check in getActivePlanState\n//     • Location: line 42-48\n//   \n//   Fix ②: subscription expiry triggers automatic downgrade\n//     • Issue: manual cleanup jobs (unreliable, scheduled)\n//     • Fix: on-demand check (evaluate every request)\n//     • Location: runOnceExpire call (automatic via getActivePlanState)\n//   \n//   Fix ⑧: new user trial credits granted once\n//     • Issue: findOrCreate called multiple times, credits re-granted each time\n//     • Fix: use upsert with $setOnInsert (only on first creation)\n//     • Location: findOrCreate upsert operation\n//   \n//   Fix BUG-H-03: topup_credits never expire (kept after downgrade)\n//     • Issue: topup credits lost when subscription expired\n//     • Fix: runOnceExpire doesn't clear topup_credits\n//     • Location: runOnceExpire, skips topup_credits in $set\n//

import { WithId } from 'mongodb';
import { getUsersCollection } from '../../config/database';
import { FREE_TRIAL_CREDITS, PLAN_CONFIG, PlanId } from '../../config/constants';
import { PlanState, UserDoc } from './user.types';
import { logger } from '../../utils/logger';

export { PlanState, UserDoc };

// Convenience alias — MongoDB always returns _id alongside our fields
type UserWithId = WithId<UserDoc>;

// ─── getActivePlanState — THE Shared Guard ────────────────────────────────────
//
// Fix ②: Called on EVERY authenticated request, not just plugin load.
// Fix ①: If plan is expired, runs runOnceExpire() — one-way door to free.
// Never refills credits. Never re-activates a pass without a new payment.
// Saves/updates name and figmaUserId if name is provided.

export async function getActivePlanState(figmaUserId: string, name?: string): Promise<{
  user: UserWithId;
  planState: PlanState;
}> {
  const users = await getUsersCollection();

  let user: UserWithId | null = await users.findOne({ figmaUserId });

  // New user: create with free plan + trial credits + username [⑧]
  if (!user) {
    user = await findOrCreate(figmaUserId, name);
  } else if (name && user.name !== name) {
    // Existing user: update stored username if it changed in Figma
    const updated = await users.findOneAndUpdate(
      { figmaUserId },
      { $set: { name, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (updated) user = updated;
  }

  // Expiry check: if plan is not free and subscription has ended [①②]
  const now = new Date();
  if (
    user.plan !== 'free' &&
    user.subscription_ends_at !== null &&
    user.subscription_ends_at < now
  ) {
    user = await runOnceExpire(figmaUserId);
  }

  // Free trial cap check
  if (user.plan === 'free' && user.credits > FREE_TRIAL_CREDITS) {
    const updated = await users.findOneAndUpdate(
      { figmaUserId },
      { $set: { credits: FREE_TRIAL_CREDITS, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (updated) user = updated;
  }

  // Build the plan state response (pass recent failure if within 5-minute window)
  const endsAt   = user.subscription_ends_at ?? null;
  const daysLeft = endsAt
    ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  let lastPaymentAttempt = user.last_payment_attempt ?? null;
  if (lastPaymentAttempt?.failed_at) {
    const ageMs = now.getTime() - new Date(lastPaymentAttempt.failed_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      lastPaymentAttempt = null;
    }
  }

  const planState: PlanState = {
    plan:                  user.plan,
    isActive:              user.plan !== 'free',
    credits:               user.credits,
    topup_credits:         user.topup_credits,
    days_left:             daysLeft,
    subscription_ends_at:  endsAt,
    subscription_cancelled: user.subscription_cancelled ?? false,
    dodo_subscription_id:  user.dodo_subscription_id ?? null,
    last_payment_attempt:  lastPaymentAttempt,
  };

  return { user, planState };
}

// ─── findOrCreate ─────────────────────────────────────────────────────────────
//
// Fix ⑧: New users get FREE_TRIAL_CREDITS — one-time grant.
// Upsert ensures this is atomic (no duplicate users from concurrent requests).

export async function findOrCreate(figmaUserId: string, name?: string): Promise<UserWithId> {
  const users = await getUsersCollection();
  const now   = new Date();

  const result = await users.findOneAndUpdate(
    { figmaUserId },
    {
      $setOnInsert: {
        plan:                    'free' as PlanId,
        credits:                 FREE_TRIAL_CREDITS,
        topup_credits:           0,
        subscription_started_at: null,
        subscription_ends_at:    null,
        dodo_subscription_id:    null,
        subscription_cancelled:  false,
        createdAt:               now,
      },
      $set: {
        name:      name || 'Figma User',
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    throw new Error('findOrCreate: failed to upsert user');
  }

  return result;
}

// ─── runOnceExpire — one-way door ①② ─────────────────────────────────────────
//
// Wipes plan, credits, and topup_credits (per user policy decision).
// Called from getActivePlanState when subscription_ends_at < now.
// Safe to call multiple times (idempotent).

async function runOnceExpire(figmaUserId: string): Promise<UserWithId> {
  const users = await getUsersCollection();

  logger.info(`[user.service] Expiring pass for ${figmaUserId}`);

  const updated = await users.findOneAndUpdate(
    { figmaUserId },
    {
      $set: {
        plan:                    'free' as PlanId,
        credits:                 0,
        // BUG-H-03 fix: topup_credits are non-expiring and roll over indefinitely
        subscription_ends_at:    null,
        subscription_started_at: null,
        subscription_cancelled:  false,
        dodo_subscription_id:    null,
        updatedAt:               new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new Error('runOnceExpire: user not found');
  }

  return updated;
}

// ─── revokeFailedPaymentPass — revokes unearned Pro status after payment failure ─

export async function revokeFailedPaymentPass(figmaUserId: string): Promise<UserWithId> {
  const users = await getUsersCollection();
  const existing = await users.findOne({ figmaUserId });
  const trialCredits = FREE_TRIAL_CREDITS;
  const resetCredits = existing && existing.credits >= 100 ? trialCredits : Math.min(existing?.credits ?? 0, trialCredits);

  logger.info(`[user.service] Revoking unearned/failed pass for ${figmaUserId} — restoring ${resetCredits} trial credits`);

  const updated = await users.findOneAndUpdate(
    { figmaUserId },
    {
      $set: {
        plan:                    'free' as PlanId,
        credits:                 resetCredits,
        subscription_ends_at:    null,
        subscription_started_at: null,
        subscription_cancelled:  false,
        dodo_subscription_id:    null,
        updatedAt:               new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new Error('revokeFailedPaymentPass: user not found');
  }

  return updated;
}

// ─── activatePlan — called by webhook on payment.succeeded ───────────────────
//
// Mid-cycle upgrade rule:
//   - days_left forfeited (not prorated — one-time pass model)
//   - topup_credits: KEPT unchanged
//   - new pass starts NOW, full 30 days
//   - plan credits reset to plan's allocation
//
// Ghost User guard: NO upsert — user MUST pre-exist.

export async function activatePlan(
  figmaUserId: string,
  planId: PlanId,
  dodoSubscriptionId: string | null = null
): Promise<UserWithId> {
  const users  = await getUsersCollection();
  const config = PLAN_CONFIG[planId];
  const now    = new Date();
  const endsAt = new Date(now);
  endsAt.setDate(endsAt.getDate() + config.durationDays);

  logger.info(`[user.service] Activating plan '${planId}' for ${figmaUserId}${dodoSubscriptionId ? ` (sub: ${dodoSubscriptionId})` : ''}`);

  const updateFields: Record<string, unknown> = {
    plan:                    planId,
    credits:                 config.credits,
    subscription_started_at: now,
    subscription_ends_at:    endsAt,
    subscription_cancelled:  false,
    updatedAt:               now,
  };

  if (dodoSubscriptionId) {
    updateFields.dodo_subscription_id = dodoSubscriptionId;
  }

  const updated = await users.findOneAndUpdate(
    { figmaUserId }, // NO upsert — must pre-exist
    {
      $set: updateFields,
      $unset: { last_payment_attempt: '' },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    logger.error(
      `[user.service] activatePlan ALERT: User '${figmaUserId}' not found — possible forged webhook or race condition. Aborting activation.`
    );
    throw new Error(`activatePlan: user '${figmaUserId}' not found — cannot activate plan`);
  }

  return updated;
}

// ─── expirePass — public alias (e.g. for refund revocation / test tools) ─────

export async function expirePass(figmaUserId: string): Promise<UserWithId> {
  return runOnceExpire(figmaUserId);
}
