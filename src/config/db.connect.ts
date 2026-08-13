// ─── config/db.connect.ts — MongoDB connection singleton & collection helpers ──
//
// Handles the low-level connection lifecycle:
//   - Cached MongoClient with ping health check & auto-reconnect
//   - Index creation (idempotent, runs once on first connect)
//   - Typed collection accessor functions

import { MongoClient, Db, Collection } from 'mongodb';
import { UserDoc, ProcessedWebhookDoc, UsageLogDoc } from './user.model';

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
  // users.figmaUserId — primary lookup key, must be unique
  await db.collection('users').createIndex(
    { figmaUserId: 1 },
    { unique: true, background: true }
  );

  // processed_webhooks.eventId — idempotency key, must be unique
  await db.collection('processed_webhooks').createIndex(
    { eventId: 1 },
    { unique: true, background: true }
  );

  // usage_logs.figmaUserId + timestamp — for per-user usage queries
  await db.collection('usage_logs').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );

  // usage_logs.timestamp — for TTL / date-range queries
  await db.collection('usage_logs').createIndex(
    { timestamp: -1 },
    { background: true }
  );

  // ai_requests.figmaUserId + timestamp — for telemetry queries
  await db.collection('ai_requests').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
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
