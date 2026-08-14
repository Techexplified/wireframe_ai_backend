// ─── modules/credits/credit.service.ts — Atomic credit operations ─────────────
//
// Fixes applied:
//   CREDIT-C-01: reserveCredits now writes a CreditReservationDoc — the server
//                stores the exact cost and pool. Refunds require the reservationId
//                and look up the amount — clients cannot inflate the refund.
//   CREDIT-M-02: refundCredits now uses findOneAndUpdate + checks matchedCount
//   CREDIT-H-01: logUsage now records pool + reservationId for ledger integrity
//   CREDIT-M-01: addTopUpCredits enforces a MAX_TOPUP_CREDITS ceiling (10,000)

import { getUsersCollection, getUsageLogsCollection, getCreditReservationsCollection } from '../../config/database';
import { CreditReservationResult } from './credit.types';
import { logger } from '../../utils/logger';
import crypto from 'crypto';

// Fix CREDIT-M-01: cap topup_credits at 10,000 to prevent overflow and unexpected platform cost
const MAX_TOPUP_CREDITS = 10_000;

// Reservation TTL — 10 minutes from creation (MongoDB TTL index uses expiresAt field)
const RESERVATION_TTL_MS = 10 * 60 * 1000;

// ─── reserveCredits — Atomic credit deduction with server-side reservation ────

export async function reserveCredits(
  figmaUserId: string,
  cost: number = 1
): Promise<CreditReservationResult> {
  const users = await getUsersCollection();
  const reservations = await getCreditReservationsCollection();

  // ── Attempt 1: deduct from plan credits pool ──────────────────────────────
  const deductPlan = await users.findOneAndUpdate(
    { figmaUserId, credits: { $gte: cost } },
    { $inc: { credits: -cost } },
    { returnDocument: 'after' }
  );

  if (deductPlan) {
    const reservationId = crypto.randomUUID();
    const now = new Date();
    await reservations.insertOne({
      reservationId,
      figmaUserId,
      cost,
      pool:      'plan',
      status:    'pending',
      reservedAt: now,
      expiresAt:  new Date(now.getTime() + RESERVATION_TTL_MS),
    });
    return {
      success:           true,
      creditsLeft:       deductPlan.credits,
      topup_creditsLeft: deductPlan.topup_credits,
      pool:              'plan',
      reservationId,
    };
  }

  // ── Attempt 2: fall back to topup_credits pool ────────────────────────────
  const deductTopup = await users.findOneAndUpdate(
    { figmaUserId, topup_credits: { $gte: cost } },
    { $inc: { topup_credits: -cost } },
    { returnDocument: 'after' }
  );

  if (deductTopup) {
    const reservationId = crypto.randomUUID();
    const now = new Date();
    await reservations.insertOne({
      reservationId,
      figmaUserId,
      cost,
      pool:      'topup',
      status:    'pending',
      reservedAt: now,
      expiresAt:  new Date(now.getTime() + RESERVATION_TTL_MS),
    });
    return {
      success:           true,
      creditsLeft:       deductTopup.credits,
      topup_creditsLeft: deductTopup.topup_credits,
      pool:              'topup',
      reservationId,
    };
  }

  return { success: false, creditsLeft: 0, topup_creditsLeft: 0, pool: 'plan', reservationId: '' };
}

// ─── refundCredits — Fix CREDIT-C-01: refund amount comes from the reservation ──
//
// The client provides only the reservationId. The server looks up the exact cost
// and pool from the reservation document. Clients cannot inflate the refund.

export async function refundCredits(
  figmaUserId: string,
  reservationId: string
): Promise<void> {
  const users        = await getUsersCollection();
  const reservations = await getCreditReservationsCollection();

  // Look up the reservation — must belong to this user and be in 'pending' state
  const reservation = await reservations.findOne({ reservationId, figmaUserId, status: 'pending' });
  if (!reservation) {
    // Already refunded, settled, expired, or belongs to a different user — safe no-op
    logger.warn(`[credit.service] refundCredits: reservation ${reservationId} not found or already processed for user ${figmaUserId}`);
    return;
  }

  const field = reservation.pool === 'plan' ? 'credits' : 'topup_credits';

  // Fix CREDIT-M-02: Use findOneAndUpdate (not updateOne) so we confirm the document existed
  const updated = await users.findOneAndUpdate(
    { figmaUserId },
    { $inc: { [field]: reservation.cost } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    logger.error(`[credit.service] refundCredits: user ${figmaUserId} not found during refund of reservation ${reservationId}`);
    return;
  }

  // Mark reservation as refunded — prevents double-refund
  await reservations.updateOne({ reservationId }, { $set: { status: 'refunded' } });
  logger.info(`[credit.service] Refunded ${reservation.cost} credits (${reservation.pool} pool) to ${figmaUserId} via reservation ${reservationId}`);
}

// ─── settleReservation — called after successful generation ────────────────────
// Marks the reservation as settled so it can't be refunded after the fact.

export async function settleReservation(reservationId: string): Promise<void> {
  const reservations = await getCreditReservationsCollection();
  await reservations.updateOne({ reservationId }, { $set: { status: 'settled' } });
}

// ─── addTopUpCredits — called by webhook on topup payment.succeeded ───────────

export async function addTopUpCredits(
  figmaUserId: string,
  creditsToAdd: number
): Promise<{ topup_credits: number }> {
  const users = await getUsersCollection();

  // Fix CREDIT-M-01: Reject if balance would exceed the ceiling
  const user = await users.findOne({ figmaUserId });
  if (!user) {
    logger.error(`[credit.service] addTopUpCredits: User '${figmaUserId}' not found`);
    throw new Error(`addTopUpCredits: user '${figmaUserId}' not found — cannot add credits`);
  }

  if (user.topup_credits + creditsToAdd > MAX_TOPUP_CREDITS) {
    const allowed = Math.max(0, MAX_TOPUP_CREDITS - user.topup_credits);
    logger.warn(`[credit.service] addTopUpCredits: capping topup_credits at ${MAX_TOPUP_CREDITS} for ${figmaUserId} (requested +${creditsToAdd}, allowed +${allowed})`);
    creditsToAdd = allowed;
  }

  if (creditsToAdd === 0) {
    return { topup_credits: user.topup_credits };
  }

  const updated = await users.findOneAndUpdate(
    { figmaUserId },
    { $inc: { topup_credits: creditsToAdd } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new Error(`addTopUpCredits: user '${figmaUserId}' not found — cannot add credits`);
  }

  return { topup_credits: updated.topup_credits };
}

// ─── logUsage — write to usage_logs collection ───────────────────────────────
// Fix CREDIT-H-01: Now records pool + reservationId for full ledger traceability.

export async function logUsage(
  figmaUserId:   string,
  action:        string,
  creditsUsed:   number,
  pool:          'plan' | 'topup',
  reservationId: string,
  promptSnippet?: string
): Promise<void> {
  try {
    const logs = await getUsageLogsCollection();
    await logs.insertOne({
      figmaUserId,
      action,
      creditsUsed,
      pool,
      reservationId,
      promptSnippet: promptSnippet?.slice(0, 80),
      timestamp:     new Date(),
    });
  } catch (err) {
    logger.warn('[credit.service] logUsage failed:', err);
  }
}
