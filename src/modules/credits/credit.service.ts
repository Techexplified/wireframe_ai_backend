// ─── modules/credits/credit.service.ts — Atomic credit operations ─────────────
//
// All credit mutations use MongoDB findOneAndUpdate with a query-side
// condition ({credits: {$gte: cost}}) so the check-and-deduct is one atomic
// operation. This prevents double-spend in concurrent requests.

import { getUsersCollection, getUsageLogsCollection } from '../../config/database';
import { CreditReservationResult } from './credit.types';

// ─── reserveCredits — Trigger B credit deduction ④ ───────────────────────────
//
// Tries plan credits first. If insufficient, falls back to topup_credits pool.
// Returns { success, creditsLeft, topup_creditsLeft }.
// Uses MongoDB atomic findOneAndUpdate so concurrent requests race safely.

export async function reserveCredits(
  figmaUserId: string,
  cost: number = 1
): Promise<CreditReservationResult> {
  const users = await getUsersCollection();

  // ── Attempt 1: deduct from plan credits pool ──────────────────────────────
  const deductPlan = await users.findOneAndUpdate(
    {
      figmaUserId,
      credits: { $gte: cost }, // atomic condition: must have enough credits
    },
    { $inc: { credits: -cost } },
    { returnDocument: 'after' }
  );

  if (deductPlan) {
    return {
      success:           true,
      creditsLeft:       deductPlan.credits,
      topup_creditsLeft: deductPlan.topup_credits,
      pool:              'plan',  // ← track which pool was used
    };
  }

  // ── Attempt 2: fall back to topup_credits pool ────────────────────────────
  const deductTopup = await users.findOneAndUpdate(
    {
      figmaUserId,
      topup_credits: { $gte: cost }, // atomic condition on topup pool
    },
    { $inc: { topup_credits: -cost } },
    { returnDocument: 'after' }
  );

  if (deductTopup) {
    return {
      success:           true,
      creditsLeft:       deductTopup.credits,
      topup_creditsLeft: deductTopup.topup_credits,
      pool:              'topup',  // ← track which pool was used
    };
  }

  // ── Neither pool had enough credits ───────────────────────────────────────
  return { success: false, creditsLeft: 0, topup_creditsLeft: 0, pool: 'plan' };
}

// ─── refundCredits — called if generation fails after deduction ④ ─────────────
//
// Determines which pool was deducted and refunds to the same pool.
// Simple $inc +cost — safe because this is called only after a confirmed deduct.

export async function refundCredits(
  figmaUserId: string,
  pool: 'plan' | 'topup',
  cost: number = 1
): Promise<void> {
  const users = await getUsersCollection();
  const field = pool === 'plan' ? 'credits' : 'topup_credits';

  await users.updateOne(
    { figmaUserId },
    { $inc: { [field]: cost } }
  );
}

// ─── addTopUpCredits — called by webhook on topup payment.succeeded ───────────
//
// Adds purchased topup credits to the topup_credits pool.
// Safe to retry ONLY because webhook idempotency check already ran [③].

export async function addTopUpCredits(
  figmaUserId: string,
  creditsToAdd: number
): Promise<{ topup_credits: number }> {
  const users = await getUsersCollection();

  const updated = await users.findOneAndUpdate(
    { figmaUserId },
    { $inc: { topup_credits: creditsToAdd } },
    {
      upsert:         true, // safety: create user if somehow missing
      returnDocument: 'after',
    }
  );

  if (!updated) {
    throw new Error('addTopUpCredits: failed to update user');
  }

  return { topup_credits: updated.topup_credits };
}

// ─── logUsage — write to usage_logs collection ───────────────────────────────
//
// Called after a successful generation. Non-blocking — errors here don't
// affect the user response.

export async function logUsage(
  figmaUserId: string,
  action: string,
  creditsUsed: number,
  promptSnippet?: string
): Promise<void> {
  try {
    const logs = await getUsageLogsCollection();
    await logs.insertOne({
      figmaUserId,
      action,
      creditsUsed,
      promptSnippet: promptSnippet?.slice(0, 80),
      timestamp: new Date(),
    });
  } catch (err) {
    // Log errors are non-fatal — generation already succeeded
    console.warn('[creditService] logUsage failed:', err);
  }
}
