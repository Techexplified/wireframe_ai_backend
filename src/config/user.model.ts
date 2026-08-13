// ─── config/user.model.ts — MongoDB document type definitions ─────────────────
//
// All TypeScript interfaces that describe documents stored in MongoDB.
// Kept separate from the connection logic so modules can import types
// without importing (and thus executing) the MongoClient setup.
//
// NOTE: These interfaces live in config/ rather than modules/ to avoid
//       circular imports (modules/ → config/database → modules/).

// ─── Users collection ─────────────────────────────────────────────────────────

export interface UserDoc {
  figmaUserId: string;
  name?: string;
  plan: 'free' | 'pro'; // only two plans: free trial and pro
  credits: number;
  topup_credits: number;
  subscription_started_at: Date | null;
  subscription_ends_at: Date | null;
  createdAt: Date;
  updatedAt?: Date;
}

// ─── Processed webhooks collection ───────────────────────────────────────────
// Stores eventId of every processed Dodo webhook for idempotency.

export interface ProcessedWebhookDoc {
  eventId: string;
  processedAt: Date;
}

// ─── Usage logs collection ────────────────────────────────────────────────────
// Written after every successful generation. Non-blocking, non-critical.

export interface UsageLogDoc {
  figmaUserId: string;
  action: string;
  creditsUsed: number;
  promptSnippet?: string;
  timestamp: Date;
}
