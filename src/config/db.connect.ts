// ─── config/db.connect.ts — MongoDB connection singleton & collection helpers ──
//
// Fixes applied:
//   PERF-H-01: Removed admin ping on every request — replaced with lazy reconnect
//   DB-L-01:   Rate limit TTL fixed from 3600s → 120s
//   AUTH-C-01: Added users.firebaseUid index for O(1) UID lookup
//   CREDIT-C-01: Added credit_reservations collection + TTL index (10 min expiry)

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
} from './user.model';

let cachedClient: MongoClient | null = null;
let cachedDb:     Db | null          = null;
let lastPingTime = 0;

export async function connectToDatabase(): Promise<Db> {
  const uri    = process.env.MONGODB_URI || '';
  const dbName = process.env.MONGODB_DB || 'wireframe_ai';

  if (!uri) throw new Error('MONGODB_URI environment variable is not set');

  const now = Date.now();
  // Return cached db if alive; verify health every 30 seconds
  if (cachedClient && cachedDb) {
    if (now - lastPingTime < 30_000) {
      return cachedDb;
    }
    try {
      await cachedClient.db('admin').command({ ping: 1 });
      lastPingTime = now;
      return cachedDb;
    } catch {
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

  // Fix PERF-H-02: Run index creation non-blockingly in background
  // to avoid adding 1.2s of latency to the first user request.
  ensureIndexes(cachedDb).catch((err) => {
    console.warn('[db.connect] Background index creation notice:', err?.message || err);
  });

  return cachedDb;
}

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

async function ensureIndexes(db: Db): Promise<void> {
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

  // 7. credit_reservations
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

  // 9. checkout_rate_limits — sliding window query index + 120s TTL
  await safeCreateIndex(
    db.collection('checkout_rate_limits'),
    { figmaUserId: 1, requestedAt: -1 },
    { background: true }
  );
  await safeCreateIndex(
    db.collection('checkout_rate_limits'),
    { requestedAt: 1 },
    { background: true, expireAfterSeconds: 120 }
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

// Export for use in connection error recovery
export { MongoServerError };
