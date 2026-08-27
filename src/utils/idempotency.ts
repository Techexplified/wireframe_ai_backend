// ─── utils/idempotency.ts — Webhook deduplication [③] ──────────────────────────
//
// Fix ③: Prevents double-processing of Dodo webhooks.
// Uses MongoDB unique index on eventId — duplicate insertOne throws E11000.
// Called FIRST in webhook handler, before any business logic.

import { getWebhooksCollection } from '../config/database';

/**
 * Marks an event as processing.
 * Returns true  → event is NEW or a retry of a previously failed event, proceed with processing.
 * Returns false → event was already processed or currently processing, return 200 OK immediately.
 */
export async function markEventProcessed(eventId: string): Promise<boolean> {
  const col = await getWebhooksCollection();
  const now = new Date();

  try {
    await col.insertOne({
      eventId,
      processedAt: now,
      status: 'processing',
    });
    return true;
  } catch (err: unknown) {
    if (isMongoServerError(err) && err.code === 11000) {
      // Check if the previous attempt failed — if so, atomically claim it for retry
      const claimed = await col.findOneAndUpdate(
        { eventId, status: 'failed' },
        { $set: { status: 'processing', updatedAt: now } }
      );
      if (claimed) {
        console.log(`[idempotency] Retrying previously failed event ${eventId}`);
        return true;
      }
      console.log(`[idempotency] Duplicate or in-flight event ${eventId} — skipping`);
      return false;
    }
    throw err;
  }
}

/**
 * Marks an event as successfully completed.
 */
export async function completeEventProcessed(eventId: string): Promise<void> {
  const col = await getWebhooksCollection();
  await col.updateOne(
    { eventId },
    { $set: { status: 'completed', updatedAt: new Date() } }
  );
}

/**
 * Marks an event as failed so Dodo can safely retry without deleting the record.
 * Prevents concurrent double-processing race conditions during retries.
 */
export async function markEventFailed(eventId: string): Promise<void> {
  const col = await getWebhooksCollection();
  await col.updateOne(
    { eventId },
    { $set: { status: 'failed', updatedAt: new Date() } }
  );
}

/** Backward compatibility alias */
export async function unmarkEventProcessed(eventId: string): Promise<void> {
  return markEventFailed(eventId);
}

// Type guard for MongoDB errors
function isMongoServerError(err: unknown): err is { code: number; message: string } {
  return typeof err === 'object' && err !== null && 'code' in err;
}
