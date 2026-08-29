// ─── config/database.ts — Re-export barrel ─────────────────────────────────────
//
// ARCHITECTURE PURPOSE:
//   • Single import point for all database utilities and types
//   • Decouples consumers from implementation details (db.connect.ts)
//   • Allows db.connect.ts to focus on connection lifecycle
//   • This file focuses on module interface & re-exports
//
// USAGE PATTERN:
//   • Consumers: import { connectToDatabase, UserDoc } from './database';
//   • Do NOT import directly from db.connect.ts (breaks encapsulation)
//   • Do NOT import directly from user.model.ts (couples to schema internals)
//
// SEPARATION OF CONCERNS:
//   • db.connect.ts   = connection pooling, index creation, lifecycle
//   • user.model.ts   = type definitions for all MongoDB collections
//   • database.ts     = public API (this file)

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
  getIpRateLimitsCollection,
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
  IpRateLimitDoc,
} from './user.model';
