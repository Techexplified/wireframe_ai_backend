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

// ─── AI Telemetry collection (`ai_requests_log`) ─────────────────────────────
// Stores full telemetry for every OpenRouter generation request.

export interface AiRequestLogDoc {
  figmaUserId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  finishReason: string;
  durationMs: number;
  complexityScore: number;
  tokenBudget: number;
  timestamp: Date;
}

// ─── Generation Rate Limits collection (`generation_rate_limits`) ───────────
// Sliding-window rate limiter records per user request attempt.

export interface RateLimitDoc {
  figmaUserId: string;
  requestedAt: Date;
}

// ─── Daily Token Quotas collection (`daily_token_quotas`) ─────────────────────
// Enforces max output token budget per user per UTC day.

export interface DailyQuotaDoc {
  figmaUserId: string;
  date: string;       // YYYY-MM-DD UTC
  tokensUsed: number;
  createdAt: Date;
}
