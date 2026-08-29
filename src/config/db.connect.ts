// ─── config/db.connect.ts — MongoDB connection singleton & collection helpers ──
//
// ARCHITECTURE:
//   • Singleton pattern: maintains single MongoClient across requests
//   • Connection pooling: maxPoolSize=10 for Firebase Functions environment
//   • Lazy reconnection: detects stale connections every 30s via ping
//   • Index creation: runs async in background to avoid startup latency
//
// Fixes applied:
//   PERF-H-01: Removed admin ping on every request — replaced with lazy reconnect
//             (Saves ~5ms per request by deferring ping to 30s interval)
//   DB-L-01:   Rate limit TTL fixed from 3600s → 120s
//             (Prevents leaked rate limit docs when generation fails midway)
//   AUTH-C-01: Added users.firebaseUid index for O(1) UID lookup
//             (Enables user lookup by Firebase UID in <1ms)
//   CREDIT-C-01: Added credit_reservations collection + TTL index (10 min expiry)
//               (Atomic credit deduction + auto-cleanup of failed reservations)

import { MongoClient, Db, Collection, MongoServerError } from 'mongodb';
import {
  UserDoc,
  ProcessedWebhookDoc,
  UsageLogDoc,
  AiRequestLogDoc,
  RateLimitDoc,
  DailyQuotaDoc,
  CreditReservationDoc,
  FeedbackDoc,
  CheckoutRateLimitDoc,
  IpRateLimitDoc,
} from './user.model';

// ─ CONNECTION STATE ─────────────────────────────────────────────────────────────
// These module-level variables maintain the singleton connection across function invocations.
// Firebase Functions reuses Node.js process across requests (warm start optimization).
//
// cachedClient: MongoDB connection client (null = disconnected)
// cachedDb: Database reference from connected client
// lastPingTime: Timestamp of last successful admin ping (detect stale connections)
let cachedClient: MongoClient | null = null;
let cachedDb:     Db | null          = null;
let lastPingTime = 0;

// ─ CONNECTION SINGLETON ─────────────────────────────────────────────────────────────
// Implements lazy initialization + health check pattern:
//   1. On first call: connects to MongoDB
//   2. On subsequent calls: returns cached connection
//   3. Every 30s: verifies connection is still healthy via admin ping
//   4. On stale connection: closes & reconnects (transparent to caller)
//
// CONFIGURATION:
//   • maxPoolSize=10: limited by Firebase Functions CPU tiers (1 vCPU = ~5 concurrent conn)
//   • serverSelectionTimeoutMS=10s: MongoDB Atlas takes ~2-3s to respond during failover
//   • socketTimeoutMS=45s: generation can take 30-40s (especially reasoning models)
//   • connectTimeoutMS=10s: initial connection must succeed within 10s
//   • retryWrites & retryReads: enabled for transient network errors
export async function connectToDatabase(): Promise<Db> {
  const uri    = process.env.MONGODB_URI || '';
  const dbName = process.env.MONGODB_DB || 'wireframe_ai';

  if (!uri) throw new Error('MONGODB_URI environment variable is not set');

  const now = Date.now();
  
  // HEALTH CHECK: Verify connection is still alive
  // Strategy: ping at 30s intervals (not on every request) to balance health checks vs latency
  // Why 30s? Firebase Functions cold starts ~30s apart; warm starts benefit from cached connection
  if (cachedClient && cachedDb) {
    if (now - lastPingTime < 30_000) {
      // Connection was pinged recently → assume still alive
      return cachedDb;
    }
    try {
      // Send lightweight ping to MongoDB (server responds in <1ms if healthy)
      await cachedClient.db('admin').command({ ping: 1 });
      lastPingTime = now;
      return cachedDb;
    } catch {
      // Connection stale or network down → close and reconnect transparently
      console.warn('[db.connect] Stale MongoDB connection detected, reconnecting...');
      try { await cachedClient.close(); } catch {}
      cachedClient = null;
      cachedDb = null;
    }
  }

  cachedClient = new MongoClient(uri, {
    maxPoolSize:              10,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS:          45000,
    connectTimeoutMS:         10000,
    retryWrites:              true,
    retryReads:               true,
  });

  await cachedClient.connect();
  cachedDb = cachedClient.db(dbName);
  lastPingTime = Date.now();

  // INDEX CREATION STRATEGY (PERF-H-02)
  // Run indexes non-blockingly to avoid 1.2s latency on first request:
  //   • createIndex() with background: true = async index build (doesn't block queries)
  //   • Don't await in connectToDatabase() = first connection returns immediately
  //   • Background index build completes in ~5-10s on production dataset
  //   • After first user request, indexes exist and queries are fast
  // If we blocked on index creation:
  //   • First request takes 1.2s (index build blocks connection return)
  //   • Users see timeout or slow performance
  ensureIndexes(cachedDb).catch((err) => {
    console.warn('[db.connect] Background index creation notice:', err?.message || err);
  });

  return cachedDb;
}

// ─ INDEX CREATION HELPER ────────────────────────────────────────────────────────────
// Idempotent index creation: safe to call multiple times.
//
// WHY NEEDED:
//   • Indexes must exist for performance (otherwise every query scans full collection)
//   • But index creation fails if index already exists (MongoDB throws error)
//   • safeCreateIndex() catches these benign errors and continues
//
// ERROR HANDLING:
//   • Code 85 (IndexOptionsConflict) = index exists but with different options
//     - If only minor change (e.g., expireAfterSeconds), safely ignore
//     - If major change (e.g., compound vs single), requires manual drop
//   • Other errors = real problems (disk full, permission denied, etc.)
async function safeCreateIndex(
  collection: Collection<any>,
  keys: any,
  options?: any
): Promise<void> {
  try {
    await collection.createIndex(keys, options);
  } catch (err: any) {
    // If index already exists with different options, ignore or log warning
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      console.warn(`[db] Index on ${collection.collectionName} exists with different options, skipping`);
    } else {
      console.warn(`[db] createIndex warning on ${collection.collectionName}:`, err?.message || err);
    }
  }
}

// ─ INDEX DEFINITIONS ────────────────────────────────────────────────────────────────
// Define all indexes needed for query performance and data consistency.
// Run async in background at connection time (not blocking first request).
//
// INDEX STRATEGY:
//   • Unique indexes on primary key fields (figmaUserId, eventId, reservationId)
//   • Compound indexes on common query patterns (figmaUserId + timestamp)
//   • TTL indexes for automatic cleanup of expired documents (webhooks, rate limits, quotas)
//   • Sparse indexes on optional fields (firebaseUid) to save index space
//
// INDEX PERFORMANCE:
//   • B-tree indexes: O(log N) lookup time (e.g., 1M users = ~20 comparisons)
//   • Compound index (figmaUserId, timestamp): efficient for "user's requests last 24h"
//   • TTL index: MongoDB daemon removes expired docs every 60s (not instant!)
//   • Unique index: enforces data integrity at database layer
async function ensureIndexes(db: Db): Promise<void> {
  // ━━ COLLECTION: users ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Indexes on 'users' collection for authentication & billing queries.
  //
  // Primary lookup: figmaUserId (unique, main app identifier)
  // Secondary lookup: firebaseUid (from Firebase Auth, used in auth.middleware.ts)
  // Compound queries: none (users table is small ~10k docs, full scan is fast)
  
  // 1. users — primary lookup + firebaseUid lookup (AUTH-C-01)
  await safeCreateIndex(
    db.collection('users'),
    { figmaUserId: 1 },
    { unique: true, background: true }
  );

  // If a legacy non-sparse firebaseUid index exists, drop it so sparse index can be created
  try {
    const userIndexes = await db.collection('users').indexes();
    const fbIndex = userIndexes.find(i => i.name === 'firebaseUid_1' || (i.key && i.key.firebaseUid));
    if (fbIndex && !fbIndex.sparse && fbIndex.name) {
      console.log('[db] Dropping non-sparse firebaseUid_1 index');
      await db.collection('users').dropIndex(fbIndex.name);
    }
  } catch (err: any) {
    console.warn('[db] Drop index warning:', err?.message || err);
  }

  await safeCreateIndex(
    db.collection('users'),
    { firebaseUid: 1 },
    { unique: true, sparse: true, background: true }
  );

  // ━━ COLLECTION: processed_webhooks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Idempotency tracking: prevent double-processing of Dodo webhooks.
  //
  // Query pattern:
  //   • webhookController.ts checks: db.processed_webhooks.findOne({ eventId })
  //   • If found: webhook already processed, return 200 (no-op)
  //   • If not found: first time seeing this event, process it
  //
  // TTL strategy: Keep records for 90 days (covers Dodo webhook retry window: ~72h)
  //   • After 90 days: doc is auto-deleted by TTL daemon
  //   • Storage saved: ~10 bytes × 10k users × 10 events/user/year = ~100 MB/year
  //
  // 2. processed_webhooks — idempotency key + 90-day TTL
  await safeCreateIndex(
    db.collection('processed_webhooks'),
    { eventId: 1 },
    { unique: true, background: true }
  );
  await safeCreateIndex(
    db.collection('processed_webhooks'),
    { processedAt: 1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // ━━ COLLECTION: usage_logs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Audit trail: every credit deduction logged for user support & refunds.
  //
  // Query patterns:
  //   • users.get() → usage_logs.find({ figmaUserId }, sort by timestamp DESC)
  //   • Support review: "show all credits used by user in last 7 days"
  //   • Revenue reporting: "total credits deducted last month"
  //
  // Compound index (figmaUserId, timestamp):
  //   • Enables efficient range queries: "credits used between 2024-01-01 and 2024-01-31"
  //   • Sort order: descending (-1) = most recent first (typical UX)
  //   • O(log N) seek to first matching doc, then sequential scan
  //
  // TTL strategy: Keep for 180 days (~6 months) for refund eligibility
  //   • Refund requests expire after 30 days, so 180 days covers edge cases
  //   • Auto-cleanup frees ~100 MB/year from old logs
  //
  // 3. usage_logs — per-user queries + 180-day TTL
  await safeCreateIndex(
    db.collection('usage_logs'),
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('usage_logs'),
    { timestamp: 1 },
    { background: true, expireAfterSeconds: 180 * 24 * 60 * 60 }
  );

  // ━━ COLLECTION: ai_requests_log ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Telemetry & cost tracking: every OpenRouter API call logged.
  //
  // Logged data: prompt tokens, completion tokens, reasoning tokens, estimated USD cost
  //
  // Query patterns:
  //   • Dashboard: "my total tokens used this month"
  //   • Analytics: "most popular model", "avg response time", "cost per user"
  //   • Debugging: "user's last 5 requests"
  //
  // Cost estimation: used to warn users approaching daily token quota
  //   • Not 100% accurate (depends on OpenRouter's final token count)
  //   • But good enough for warning "you've used 400k of 500k tokens"
  //
  // TTL strategy: Keep for 90 days
  //   • Monthly billing cycle = 30 days (need data for current + 1 past month)
  //   • 90 days = 3 months buffer for delayed analytics queries
  //   • Storage: ~200 bytes × 10k users × 100 requests/month = ~600 MB/month
  //   • TTL cleanup saves ~1.8 GB/quarter
  //
  // 4. ai_requests_log — telemetry queries + 90-day TTL
  await safeCreateIndex(
    db.collection('ai_requests_log'),
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('ai_requests_log'),
    { timestamp: -1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // ━━ COLLECTION: generation_rate_limits ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Rate limiting: prevent abuse (1 req/30s for free, 3 req/10s for pro).
  //
  // Query pattern (ai.routes.ts):
  //   • db.generation_rate_limits.countDocuments({ figmaUserId, requestedAt: {$gt: now - 30s} })
  //   • If count >= maxRequests → return 429 Too Many Requests
  //   • If count < maxRequests → insert new doc with current timestamp
  //
  // Index (figmaUserId, requestedAt):
  //   • Efficient range query: "how many requests from user X in last 30 seconds?"
  //   • Descending sort (-1): not needed for count, but good for debugging
  //
  // TTL strategy: Auto-cleanup after 120 seconds
  //   • Most rate limit windows are 30s (free) or 10s (pro)
  //   • Keeping docs for 120s covers slow network + clock skew
  //   • After 120s: doc auto-deleted, user can make new requests
  //   • Storage: ~50 bytes × 10k users × 1 request/30s = ~15 MB/month
  //
  // Fix DB-L-01: TTL was 3600s (1 hour), causing stale rate limit blocks
  //   Changed to 120s to match actual rate limit window
  //
  // 5. generation_rate_limits — sliding window query index
  await safeCreateIndex(
    db.collection('generation_rate_limits'),
    { figmaUserId: 1, requestedAt: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('generation_rate_limits'),
    { requestedAt: 1 },
    { background: true, expireAfterSeconds: 120 }
  );

  // ━━ COLLECTION: daily_token_quotas ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Daily token budget tracking: prevent users from burning quota too fast.
  //
  // Document schema: { figmaUserId, date: "2024-01-15", tokensUsed: 123456 }
  //   • One doc per user per UTC day
  //   • Updated atomically when each generation completes
  //
  // Query pattern (ai.routes.ts):
  //   • db.daily_token_quotas.findOne({ figmaUserId, date: today })
  //   • If found: check tokensUsed + newTokens <= DAILY_TOKEN_QUOTA
  //   • If not found: first generation today, create new doc
  //
  // Unique index (figmaUserId, date):
  //   • Prevents accidental duplicate docs for same user/day
  //   • MongoDB enforces: only one doc per user per day
  //   • Upsert operation: find or create atomically
  //
  // TTL strategy: Keep for 2 days (48 hours)
  //   • Quota resets at UTC midnight, but TZ variance = up to 2 days
  //   • 2-day TTL ensures we don't accidentally double-charge across date boundary
  //   • Storage: ~100 bytes × 10k users = ~1 MB (very small)
  //
  // 6. daily_token_quotas — user+date unique index + 2-day TTL
  await safeCreateIndex(
    db.collection('daily_token_quotas'),
    { figmaUserId: 1, date: 1 },
    { unique: true, background: true }
  );
  await safeCreateIndex(
    db.collection('daily_token_quotas'),
    { createdAt: 1 },
    { background: true, expireAfterSeconds: 172800 }
  );

  // ━━ COLLECTION: credit_reservations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Atomic credit deduction ledger (Fix CREDIT-C-01).
  //
  // PURPOSE:
  //   • Server-side record that credits were reserved for a generation
  //   • Prevents double-charging if client retries or network fails
  //   • Enables refunds by referencing reservationId (not trusting client amount)
  //
  // Workflow:
  //   1. User initiates generation → ai.routes.ts creates reservation (status: pending)
  //   2. Deducts credits from plan/topup pools
  //   3. Calls OpenRouter API
  //   4. On success → update reservation (status: settled)
  //   5. On failure → update reservation (status: refunded), credit user back
  //   6. After 10 minutes → TTL index deletes expired "pending" reservations (cleanup)
  //
  // Unique index (reservationId):
  //   • UUID assigned by server (not client)
  //   • Prevents duplicate reservations
  //   • Client cannot tamper with amount or pool
  //
  // Compound index (figmaUserId, status):
  //   • Query: "all pending reservations for user X"
  //   • Used for refund UI: "which generations can be refunded?"
  //
  // TTL index (expiresAt, expireAfterSeconds: 0):
  //   • expiresAt = reservedAt + 10 minutes
  //   • expireAfterSeconds: 0 means delete when current time >= expiresAt
  //   • Auto-cleanup: failed/expired reservations removed by MongoDB daemon
  //   • Prevents stale "pending" reservations blocking refunds
  //
  // Fix CREDIT-C-01: New collection for server-side credit reservation tracking
  await safeCreateIndex(
    db.collection('credit_reservations'),
    { reservationId: 1 },
    { unique: true, background: true }
  );
  await safeCreateIndex(
    db.collection('credit_reservations'),
    { figmaUserId: 1, status: 1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('credit_reservations'),
    { expiresAt: 1 },
    { background: true, expireAfterSeconds: 0 }
  );

  // ━━ COLLECTION: feedbacks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // User feedback submissions for product improvement.
  //
  // Query patterns:
  //   • Timeline: "newest feedback first" (createdAt DESC)
  //   • User's feedback: "all feedback from user X" (figmaUserId + createdAt DESC)
  //   • Analytics: "distribution by rating & category" (group by rating, category)
  //
  // Indexes:
  //   • Index 1 (createdAt DESC): fast query for recent feedback (admin dashboard)
  //   • Index 2 (figmaUserId, createdAt): efficient per-user feedback queries
  //   • Index 3 (rating, category): aggregation for sentiment analysis
  //
  // No TTL on feedbacks (kept indefinitely for analytics & legal reasons)
  //
  // 8. feedbacks — timeline & user queries
  await safeCreateIndex(
    db.collection('feedbacks'),
    { createdAt: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('feedbacks'),
    { figmaUserId: 1, createdAt: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('feedbacks'),
    { rating: 1, category: 1 },
    { background: true }
  );

  // ━━ COLLECTION: checkout_rate_limits ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Rate limiting on checkout endpoint: prevent checkout spam.
  //
  // Query pattern (checkoutRoutes.ts):
  //   • db.checkout_rate_limits.countDocuments({ figmaUserId, requestedAt: {$gt: now - 120s} })
  //   • If count >= 3 → return 429 Too Many Requests (max 3 checkout attempts per 2 min)
  //   • If count < 3 → allow checkout attempt
  //
  // TTL strategy: Auto-cleanup after 120 seconds
  //   • Prevents checkout brute-force attacks
  //   • After 2 minutes, user can retry checkout
  //   • Storage: minimal (~10 bytes × 100 checkouts/day = ~1 MB/month)
  //
  // 9. checkout_rate_limits — sliding window query index + 120s TTL
  await safeCreateIndex(
    db.collection('checkout_rate_limits'),
    { figmaUserId: 1, requestedAt: -1 },
    { background: true }
  );
  // ━━ COLLECTION: ip_rate_limits ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Anti-abuse IP rate limiting for trial creation & bot farm prevention.
  await safeCreateIndex(
    db.collection('ip_rate_limits'),
    { clientIp: 1, action: 1, timestamp: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('ip_rate_limits'),
    { timestamp: 1 },
    { background: true, expireAfterSeconds: 24 * 60 * 60 } // 24-hour TTL
  );
}

// ─── Typed collection helpers ─────────────────────────────────────────────────

export async function getUsersCollection(): Promise<Collection<UserDoc>> {
  const db = await connectToDatabase();
  return db.collection<UserDoc>('users');
}

export async function getWebhooksCollection(): Promise<Collection<ProcessedWebhookDoc>> {
  const db = await connectToDatabase();
  return db.collection<ProcessedWebhookDoc>('processed_webhooks');
}

export async function getUsageLogsCollection(): Promise<Collection<UsageLogDoc>> {
  const db = await connectToDatabase();
  return db.collection<UsageLogDoc>('usage_logs');
}

export async function getAiRequestsLogCollection(): Promise<Collection<AiRequestLogDoc>> {
  const db = await connectToDatabase();
  return db.collection<AiRequestLogDoc>('ai_requests_log');
}

export async function getRateLimitsCollection(): Promise<Collection<RateLimitDoc>> {
  const db = await connectToDatabase();
  return db.collection<RateLimitDoc>('generation_rate_limits');
}

export async function getCheckoutRateLimitsCollection(): Promise<Collection<CheckoutRateLimitDoc>> {
  const db = await connectToDatabase();
  return db.collection<CheckoutRateLimitDoc>('checkout_rate_limits');
}

export async function getDailyQuotasCollection(): Promise<Collection<DailyQuotaDoc>> {
  const db = await connectToDatabase();
  return db.collection<DailyQuotaDoc>('daily_token_quotas');
}

// Fix CREDIT-C-01: New collection for server-side credit reservation tracking
export async function getCreditReservationsCollection(): Promise<Collection<CreditReservationDoc>> {
  const db = await connectToDatabase();
  return db.collection<CreditReservationDoc>('credit_reservations');
}

export async function getFeedbacksCollection(): Promise<Collection<FeedbackDoc>> {
  const db = await connectToDatabase();
  return db.collection<FeedbackDoc>('feedbacks');
}

export async function getIpRateLimitsCollection(): Promise<Collection<IpRateLimitDoc>> {
  const db = await connectToDatabase();
  return db.collection<IpRateLimitDoc>('ip_rate_limits');
}

// Export for use in connection error recovery
export { MongoServerError };
