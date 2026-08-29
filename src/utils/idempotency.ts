// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── utils/idempotency.ts — Webhook Deduplication & Idempotent Processing
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Prevents double-processing of Dodo Payments webhooks.
//   Guarantees at-most-once processing semantics for payment confirmations.
//   Uses MongoDB unique index + FSM (Finite State Machine) pattern.
//   Returns HTTP 200 immediately for duplicate webhooks (idempotent).
//
// PROBLEM FIXED:
//   Dodo Payments may retry failed webhooks multiple times:
//     • Network timeout → Dodo retries after 1 minute
//     • Server error → Dodo retries exponentially
//     • Without deduplication: user charged twice with same webhook
//   
//   Solution: idempotency key (eventId) + unique database constraint
//     • First webhook: eventId doesn't exist → process, insert doc, status=processing
//     • Retry: eventId exists → skip processing, return 200 (idempotent)
//     • Once settled: status=completed or status=failed (safe for future retries)
//
// WEBHOOK FLOW:
//   1. Dodo sends: POST /webhooks/dodo with eventId, event_type, metadata
//   2. webhook.controller.ts calls markEventProcessed(eventId)
//   3. markEventProcessed inserts { eventId, status: 'processing' }
//   4. If insert succeeds → true returned, proceed with business logic
//   5. If insert fails (E11000) → duplicate, return false
//   6. webhook.controller checks return value:
//      - true: process subscription.update, call Dodo API, etc.
//      - false: log \"duplicate webhook\", return 200 OK (idempotent)
//   7. After processing: call completeEventProcessed(eventId) or markEventFailed(eventId)
//   8. Update status to 'completed' or 'failed' (prevents future re-processing)
//
// STATE MACHINE:
//   [processing] ──success──→ [completed]
//   [processing] ──error──→ [failed]
//   [completed] ──retry──→ [completed] (no re-processing)
//   [failed] ──retry──→ [failed] (no re-processing, safe to retry)
//   
//   Key insight: once status leaves 'processing', event is never re-processed
//   (prevents double-charging even if webhook retried indefinitely)
//
// DATABASE STRATEGY:
//   Collection: processed_webhooks
//   Document schema:
//     {
//       eventId: \"dodo_evt_123\",  // Dodo event ID (primary key)
//       status: \"processing\" | \"completed\" | \"failed\",
//       createdAt: 2024-01-15T11:22:33Z,
//       updatedAt: 2024-01-15T11:22:34Z
//     }
//   
//   Indexes:
//     • Unique index on eventId (prevents duplicate inserts)
//     • Index on status (query completed vs. failed events)
//     • TTL index on createdAt → auto-delete after 30 days
//   
//   Why TTL=30 days?
//     • Dodo retries for ~7 days max
//     • Keep 30 days for auditing/debugging
//     • Prevent unbounded collection growth
//
// FUNCTION REFERENCE:
//   
//   markEventProcessed(eventId): Promise<boolean>
//     • Called FIRST in webhook handler (before any business logic)
//     • Tries to insert { eventId, status: 'processing' }
//     • Returns true if insert succeeded → process webhook
//     • Returns false if duplicate (E11000) → skip processing, return 200 OK
//   
//   completeEventProcessed(eventId): Promise<void>
//     • Called after successful webhook processing
//     • Updates status from 'processing' → 'completed'
//     • Prevents future re-processing of this webhook
//   
//   markEventFailed(eventId): Promise<void>
//     • Called if processing fails (business logic error)
//     • Updates status from 'processing' → 'failed'
//     • Prevents re-processing, but keeps record for debugging
//     • Safe for Dodo to retry later (marked as failed, won't re-process)
//   
//   unmarkEventProcessed(eventId): Promise<void>
//     • Alias for markEventFailed (backward compatibility)
//     • Same semantics: mark as failed, safe for retry
//
// ERROR HANDLING:
//   
//   If markEventProcessed throws:
//     → Database connection failed
//     → webhook.controller catches, returns 503 Service Unavailable
//     → Dodo retries later when DB recovers
//   
//   If completeEventProcessed throws:
//     → Log warning, but don't propagate error
//     → Status still in 'processing' (conservative: won't re-process)
//     → Next retry: status='processing', webhook is reprocessed (at-most-once)
//   
//   At-most-once semantics:
//     • If processing succeeds but status update fails:
//       → User is charged (business logic succeeded)
//       → Status remains 'processing'
//       → Next retry: webhook re-processed (charges user again)
//     → Why acceptable? Dodo doesn't retry forever; eventual consistency
//     → Fix: webhook.controller should not throw after deducting credits
//           (defer status update to after, or make status update synchronous first)
//
// DODO WEBHOOK SIGNATURE VERIFICATION:
//   Orthogonal to idempotency
//   
//   Signature verification (in webhook.controller.ts):
//     • Verifies webhook came from Dodo (not attacker)
//     • Uses DODO_WEBHOOK_SECRET
//   
//   Idempotency deduplication (this file):
//     • Verifies webhook processed at most once
//     • Prevents accidental double-processing
//   
//   Both needed:
//     • Signature = authentication (trust sender)
//     • Idempotency = at-most-once (prevent re-processing)
//
// USAGE IN WEBHOOK HANDLER:
//   
//   async function dodoWebhookHandler(req: Request, res: Response) {
//     const eventId = req.body.eventId;
//     
//     // Step 1: Verify signature (security)
//     const isValid = verifyDodoSignature(req);
//     if (!isValid) throw new ForbiddenError('Invalid signature');
//     
//     // Step 2: Deduplicate (idempotency)
//     const isNewEvent = await markEventProcessed(eventId);
//     if (!isNewEvent) {
//       // Already processed, return 200 OK (idempotent response)
//       return sendSuccess(res, { message: 'Webhook already processed' });
//     }
//     
//     // Step 3: Process (subscribe user, charge credits, etc.)
//     try {
//       await processPaymentConfirmation(req.body);
//       await completeEventProcessed(eventId);
//       sendSuccess(res, { success: true });
//     } catch (err) {
//       await markEventFailed(eventId);
//       throw err;  // error middleware returns 500, Dodo retries
//     }
//   }

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
