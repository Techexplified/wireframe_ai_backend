// ─── config/database.ts — Re-export barrel ─────────────────────────────────────

export {
  connectToDatabase,
  getUsersCollection,
  getWebhooksCollection,
  getUsageLogsCollection,
  getAiRequestsLogCollection,
  getRateLimitsCollection,
  getCheckoutRateLimitsCollection,
  getDailyQuotasCollection,
  getCreditReservationsCollection,  // Fix CREDIT-C-01: new reservation collection
  getFeedbacksCollection,
} from './db.connect';

export type {
  UserDoc,
  PaymentAttemptInfo,
  ProcessedWebhookDoc,
  UsageLogDoc,
  AiRequestLogDoc,
  RateLimitDoc,
  CheckoutRateLimitDoc,
  DailyQuotaDoc,
  CreditReservationDoc,             // Fix CREDIT-C-01: new type
  FeedbackDoc,
} from './user.model';
