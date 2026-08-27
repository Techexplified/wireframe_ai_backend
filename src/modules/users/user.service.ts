// ─── modules/users/user.service.ts — Core user lifecycle operations ───────────
//
// Implements the Shared Guard logic (getActivePlanState) and all user mutations.
// Single source of truth for plan state — all routes call this.

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
