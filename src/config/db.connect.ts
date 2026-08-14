// ─── config/db.connect.ts — MongoDB connection singleton & collection helpers ──
//
// Handles the low-level connection lifecycle:
//   - Cached MongoClient with ping health check & auto-reconnect
//   - Index creation (idempotent, runs once on first connect)
//   - Typed collection accessor functions

import { MongoClient, Db, Collection } from 'mongodb';
import {
  UserDoc,
  ProcessedWebhookDoc,
  UsageLogDoc,
  AiRequestLogDoc,
  RateLimitDoc,
  DailyQuotaDoc,
} from './user.model';

let cachedClient: MongoClient | null = null;

export async function connectToDatabase(): Promise<Db> {
  const uri    = process.env.MONGODB_URI || '';
  const dbName = process.env.MONGODB_DB || process.env.MONGO_DB_NAME || 'wireframe_ai';

  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize:              10,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS:          45000,
      connectTimeoutMS:         10000,
      retryWrites:              true,
      retryReads:               true,
    });
    await cachedClient.connect();
    const db = cachedClient.db(dbName);
    await ensureIndexes(db);
  }

  try {
    // Connection health check ping
    await cachedClient.db('admin').command({ ping: 1 });
  } catch (err) {
    console.warn('[Database] Connection ping failed, reconnecting...', err);
    cachedClient = null;
    return connectToDatabase();
  }

  return cachedClient.db(dbName);
}

// ─── Index creation (idempotent) ─────────────────────────────────────────────

async function ensureIndexes(db: Db): Promise<void> {
  // 1. users.figmaUserId — primary lookup key, must be unique
  await db.collection('users').createIndex(
    { figmaUserId: 1 },
    { unique: true, background: true }
  );

  // 2. processed_webhooks.eventId — idempotency key, must be unique
  await db.collection('processed_webhooks').createIndex(
    { eventId: 1 },
    { unique: true, background: true }
  );

  // usage_logs.figmaUserId + timestamp — per-user usage queries
  await db.collection('usage_logs').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  // usage_logs.timestamp — 180-day TTL auto-expiry
  await db.collection('usage_logs').createIndex(
    { timestamp: 1 },
    { background: true, expireAfterSeconds: 180 * 24 * 60 * 60 }
  );

  // processed_webhooks.processedAt — 90-day TTL to prevent indefinite growth
  await db.collection('processed_webhooks').createIndex(
    { processedAt: 1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // 4. ai_requests_log — telemetry queries & 90-day TTL auto-expiry
  await db.collection('ai_requests_log').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  await db.collection('ai_requests_log').createIndex(
    { timestamp: -1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );

  // 5. generation_rate_limits — sliding window query index + 1-hour TTL auto-expiry
  await db.collection('generation_rate_limits').createIndex(
    { figmaUserId: 1, requestedAt: -1 },
    { background: true }
  );
  await db.collection('generation_rate_limits').createIndex(
    { requestedAt: 1 },
    { background: true, expireAfterSeconds: 3600 }
  );

  // 6. daily_token_quotas — user+date unique index + 2-day TTL auto-expiry
  await db.collection('daily_token_quotas').createIndex(
    { figmaUserId: 1, date: 1 },
    { unique: true, background: true }
  );
  await db.collection('daily_token_quotas').createIndex(
    { createdAt: 1 },
    { background: true, expireAfterSeconds: 172800 }
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
