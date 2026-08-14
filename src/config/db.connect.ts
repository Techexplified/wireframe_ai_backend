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
} from './user.model';

let cachedClient: MongoClient | null = null;
let cachedDb:     Db | null          = null;

export async function connectToDatabase(): Promise<Db> {
  const uri    = process.env.MONGODB_URI || '';
  const dbName = process.env.MONGODB_DB || 'wireframe_ai';

  if (!uri) throw new Error('MONGODB_URI environment variable is not set');

  // Fix PERF-H-01: Return cached db immediately — no ping on every request.
  // Lazy reconnect: if a real operation fails with MongoNetworkError, callers
  // should catch and call connectToDatabase() again (retryWrites handles most cases).
  if (cachedClient && cachedDb) {
    return cachedDb;
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
  await ensureIndexes(cachedDb);

  return cachedDb;
}

// ─── Index creation (idempotent — safe to re-run on reconnect) ───────────────

async function ensureIndexes(db: Db): Promise<void> {
  // 1. users — primary lookup + firebaseUid lookup (AUTH-C-01)
  await db.collection('users').createIndex(
    { figmaUserId: 1 },
    { unique: true, background: true }
  );
  await db.collection('users').createIndex(
    { firebaseUid: 1 },
    { unique: true, sparse: true, background: true }  // sparse: users pre-existing auth don't have it yet
  );

  // 2. processed_webhooks — idempotency key + 90-day TTL
  await db.collection('processed_webhooks').createIndex(
    { eventId: 1 },
    { unique: true, background: true }
  );
  await db.collection('processed_webhooks').createIndex(
    { processedAt: 1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // 3. usage_logs — per-user queries + 180-day TTL
  await db.collection('usage_logs').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  await db.collection('usage_logs').createIndex(
    { timestamp: 1 },
    { background: true, expireAfterSeconds: 180 * 24 * 60 * 60 }
  );

  // 4. ai_requests_log — telemetry queries + 90-day TTL
  await db.collection('ai_requests_log').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  await db.collection('ai_requests_log').createIndex(
    { timestamp: -1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // 5. generation_rate_limits — sliding window query index
  //    Fix DB-L-01: TTL was 3600s (1 hour) but window is max 30s. Now 120s (4× the window).
  await db.collection('generation_rate_limits').createIndex(
    { figmaUserId: 1, requestedAt: -1 },
    { background: true }
  );
  await db.collection('generation_rate_limits').createIndex(
    { requestedAt: 1 },
    { background: true, expireAfterSeconds: 120 }
  );

  // 6. daily_token_quotas — user+date unique index + 2-day TTL
  await db.collection('daily_token_quotas').createIndex(
    { figmaUserId: 1, date: 1 },
    { unique: true, background: true }
  );
  await db.collection('daily_token_quotas').createIndex(
    { createdAt: 1 },
    { background: true, expireAfterSeconds: 172800 }
  );

  // 7. credit_reservations — Fix CREDIT-C-01: server-side reservation tracking.
  //    reservationId is the refund key (UUID). Expires after 10 minutes via TTL.
  await db.collection('credit_reservations').createIndex(
    { reservationId: 1 },
    { unique: true, background: true }
  );
  await db.collection('credit_reservations').createIndex(
    { figmaUserId: 1, status: 1 },
    { background: true }
  );
  await db.collection('credit_reservations').createIndex(
    { expiresAt: 1 },
    { background: true, expireAfterSeconds: 0 }  // TTL: uses document's expiresAt field directly
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

export async function getDailyQuotasCollection(): Promise<Collection<DailyQuotaDoc>> {
  const db = await connectToDatabase();
  return db.collection<DailyQuotaDoc>('daily_token_quotas');
}

// Fix CREDIT-C-01: New collection for server-side credit reservation tracking
export async function getCreditReservationsCollection(): Promise<Collection<CreditReservationDoc>> {
  const db = await connectToDatabase();
  return db.collection<CreditReservationDoc>('credit_reservations');
}

// Export for use in connection error recovery
export { MongoServerError };
