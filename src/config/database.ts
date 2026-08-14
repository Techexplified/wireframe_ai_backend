// ─── config/database.ts — Re-export barrel (backwards compatibility) ───────────
//
// database.ts re-exports from two focused files:
//   - db.connect.ts  : MongoDB connection singleton + collection helpers
//   - user.model.ts  : Document interfaces (UserDoc, ProcessedWebhookDoc, etc.)
//
// This file re-exports everything from both so existing imports continue to
// work without any changes.

export {
  connectToDatabase,
  getUsersCollection,
  getWebhooksCollection,
  getUsageLogsCollection,
  getAiRequestsLogCollection,
  getRateLimitsCollection,
  getDailyQuotasCollection,
} from './db.connect';

export type {
  UserDoc,
  ProcessedWebhookDoc,
  UsageLogDoc,
  AiRequestLogDoc,
  RateLimitDoc,
  DailyQuotaDoc,
} from './user.model';
