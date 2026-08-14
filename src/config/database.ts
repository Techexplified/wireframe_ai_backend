// ─── config/database.ts — Re-export barrel ─────────────────────────────────────

export {
  connectToDatabase,
  getUsersCollection,
  getWebhooksCollection,
  getUsageLogsCollection,
  getAiRequestsLogCollection,
  getRateLimitsCollection,
  getDailyQuotasCollection,
  getCreditReservationsCollection,  // Fix CREDIT-C-01: new reservation collection
} from './db.connect';

export type {
  UserDoc,
  ProcessedWebhookDoc,
  UsageLogDoc,
  AiRequestLogDoc,
  RateLimitDoc,
  DailyQuotaDoc,
  CreditReservationDoc,             // Fix CREDIT-C-01: new type
} from './user.model';
