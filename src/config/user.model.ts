// ─── config/user.model.ts — MongoDB document type definitions ─────────────────
//
// All TypeScript interfaces that describe documents stored in MongoDB.
// Kept separate from the connection logic so modules can import types
// without importing (and thus executing) the MongoClient setup.

// ─── Users collection ─────────────────────────────────────────────────────────

export interface UserDoc {
  figmaUserId: string;
  firebaseUid?: string;    // Fix AUTH-C-01: Firebase Anonymous UID bound on first auth
  name?: string;
  plan: 'free' | 'pro';
  credits: number;
  topup_credits: number;
  subscription_started_at: Date | null;
  subscription_ends_at: Date | null;
  dodo_subscription_id?: string | null;
  subscription_cancelled?: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

// ─── Processed webhooks collection ───────────────────────────────────────────

export interface ProcessedWebhookDoc {
  eventId: string;
  processedAt: Date;
}

// ─── Credit Reservations collection ──────────────────────────────────────────
// Fix CREDIT-C-01: Server-side record of each credit deduction.
// Refund must reference the reservationId — client cannot inflate the amount.

export interface CreditReservationDoc {
  reservationId: string;    // UUID — sent to client as X-Reservation-Id header
  figmaUserId:   string;
  cost:          number;    // authoritative credit cost from server
  pool:          'plan' | 'topup';
  status:        'pending' | 'settled' | 'refunded';
  reservedAt:    Date;
  expiresAt:     Date;      // TTL: 10 minutes — auto-removed by MongoDB TTL index
}

// ─── Usage logs collection ────────────────────────────────────────────────────

export interface UsageLogDoc {
  figmaUserId:    string;
  action:         string;
  creditsUsed:    number;
  pool:           'plan' | 'topup';  // Fix CREDIT-H-01: which pool was deducted
  reservationId?: string;            // Fix CREDIT-H-01: links to reservation record
  promptSnippet?: string;
  timestamp:      Date;
}

// ─── AI Telemetry collection (`ai_requests_log`) ─────────────────────────────

export interface AiRequestLogDoc {
  figmaUserId:      string;
  model:            string;
  promptTokens:     number;
  completionTokens: number;
  reasoningTokens:  number;
  totalTokens:      number;
  estimatedCostUSD: number;
  finishReason:     string;
  durationMs:       number;
  complexityScore:  number;
  tokenBudget:      number;
  timestamp:        Date;
}

// ─── Generation Rate Limits collection (`generation_rate_limits`) ────────────

export interface RateLimitDoc {
  figmaUserId: string;
  requestedAt: Date;
}

// ─── Daily Token Quotas collection (`daily_token_quotas`) ─────────────────────

export interface DailyQuotaDoc {
  figmaUserId: string;
  date:        string;       // YYYY-MM-DD UTC
  tokensUsed:  number;
  createdAt:   Date;
}
