// ─── utils/idempotency.ts — Webhook deduplication [③] ──────────────────────────
//
// Fix ③: Prevents double-processing of Dodo webhooks.
// Uses MongoDB unique index on eventId — duplicate insertOne throws E11000.
// Called FIRST in webhook handler, before any business logic.

import { getWebhooksCollection } from '../config/database';

/**
 * Marks an event as processed.
 * Returns true  → event is NEW, proceed with processing.
 * Returns false → event was already seen, return 200 OK immediately (no-op).
 */
export async function markEventProcessed(eventId: string): Promise<boolean> {
  const col = await getWebhooksCollection();

  try {
    await col.insertOne({
      eventId,
      processedAt: new Date(),
    });
    // Insert succeeded → first time we've seen this event
    return true;
  } catch (err: unknown) {
    // MongoDB duplicate key error code 11000
    if (isMongoServerError(err) && err.code === 11000) {
      console.log(`[idempotency] Duplicate event ${eventId} — skipping`);
      return false;
    }
    // Any other error is unexpected — re-throw to let the webhook handler 500
    throw err;
  }
}

/**
 * Unmarks an event as processed.
 * Called when business logic (activatePlan/addTopUpCredits) fails AFTER the
 * idempotency record was committed, so Dodo can safely retry the webhook.
 */
export async function unmarkEventProcessed(eventId: string): Promise<void> {
  const col = await getWebhooksCollection();
  await col.deleteOne({ eventId });
}

// Type guard for MongoDB errors
function isMongoServerError(err: unknown): err is { code: number; message: string } {
  return typeof err === 'object' && err !== null && 'code' in err;
}
