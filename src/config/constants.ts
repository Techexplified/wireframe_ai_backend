// ─── constants.ts — Plan configuration, credit packs, and app constants ───────
//
// Single source of truth for all plan limits and pricing configuration.
// Change values here, not scattered across routes.

export const FREE_TRIAL_CREDITS = parseInt(process.env.FREE_TRIAL_CREDITS || '3', 10);

// ─── Plans ───────────────────────────────────────────────────────────────────
// Only two plans: 'free' (trial) and 'pro' ($20/month, 100 credits).

export type PlanId = 'free' | 'pro';

export const PLAN_CONFIG: Record<PlanId, {
  credits: number;         // credits granted on activation
  durationDays: number;    // pass duration in days
  priceId: string;         // Dodo product/price ID
}> = {
  free: {
    credits: FREE_TRIAL_CREDITS,
    durationDays: 0,
    priceId: '',
  },
  pro: {
    credits: 100,
    durationDays: 30,
    priceId: process.env.DODO_PRODUCT_PRO || '',
  },
};

// ─── Credit Top-Up Packs ─────────────────────────────────────────────────────
// Available to Pro plan subscribers only.

export type TopUpPackId = 'small' | 'medium' | 'large';

export const TOPUP_PACKS: Record<TopUpPackId, {
  credits: number;
  priceLabel: string;
  priceId: string;
}> = {
  small: {
    credits: 20,
    priceLabel: '$4.99',
    priceId: process.env.DODO_PRODUCT_TOPUP_SMALL || '',
  },
  medium: {
    credits: 50,
    priceLabel: '$9.99',
    priceId: process.env.DODO_PRODUCT_TOPUP_MEDIUM || '',
  },
  large: {
    credits: 100,
    priceLabel: '$19.99',
    priceId: process.env.DODO_PRODUCT_TOPUP_LARGE || '',
  },
};

// ─── Feature Costs ────────────────────────────────────────────────────────────
// Default credit cost for generation (fallback when model key is unknown).
export const CREDIT_COST_GENERATE = 1;

// ─── Model Credit Cost Table ──────────────────────────────────────────────────
// Credits deducted per generation based on the selected model (UI key).
// Must stay in sync with MODEL_MAP keys below.
//
//   kimi-2-6          → 2 credits (less powerful, but costs more credits — incentivises Luna)
//   gpt-5-6-luna      → 1 credit  (default / recommended)
//   claude-sonnet-4-5 → 5 credits (premium model)
//   gpt-4o            → 4 credits
//   gemini-1-5        → 2 credits
//
// Free users are always routed to gpt-5.6-luna (1 credit/gen) regardless of selection.

export const MODEL_CREDIT_COST: Record<string, number> = {
  'kimi-2-6':          2,
  'gpt-5-6-luna':      1,
  'claude-sonnet-4-5': 5,
  'gpt-4o':            4,
  'gemini-1-5':        2,
};

// ─── AI Model Map ─────────────────────────────────────────────────────────────
// Maps user-facing model keys to OpenRouter model identifiers.

export const MODEL_MAP: Record<string, string> = {
  'kimi-2-6':          'moonshotai/kimi-k2:free',
  'gpt-5-6-luna':      'openai/gpt-5.6-luna',
  'claude-sonnet-4-5': 'anthropic/claude-sonnet-4-5',
  'gpt-4o':            'openai/gpt-4o',
  'gemini-1-5':        'google/gemini-2.0-flash-001',
};
export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
export const DEFAULT_MODEL_KEY = 'gpt-5-6-luna';

// ─── Model Pricing Table ──────────────────────────────────────────────────────
// USD cost per 1 million tokens (input / output).
// Used by telemetry to compute estimated cost per request.

export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'moonshotai/kimi-k2:free':       { inputPer1M: 0,    outputPer1M: 0     },
  'google/gemini-2.0-flash-001':   { inputPer1M: 0.10, outputPer1M: 0.40  },
  'openai/gpt-5.6-luna':           { inputPer1M: 0.10, outputPer1M: 0.60  },
  'openai/gpt-4o':                 { inputPer1M: 2.50, outputPer1M: 10.00 },
  'anthropic/claude-sonnet-4-5':   { inputPer1M: 3.00, outputPer1M: 15.00 },
};

// ─── AI Rate Limit Config ─────────────────────────────────────────────────────
// Sliding-window rate limit per user per plan.

export const RATE_LIMIT_CONFIG: Record<PlanId, { windowMs: number; maxRequests: number }> = {
  free: { windowMs: 30_000, maxRequests: 1 },  // 1 request / 30s
  pro:  { windowMs: 10_000, maxRequests: 3 },  // 3 requests / 10s
};

// ─── Daily Token Quota ────────────────────────────────────────────────────────
// Max total output tokens per user per UTC day (abuse prevention floor).

export const DAILY_TOKEN_QUOTA: Record<PlanId, number> = {
  free: 50_000,
  pro:  500_000,
};

// ─── Per-Request Cost Cap ─────────────────────────────────────────────────────
// Maximum estimated USD cost allowed per single generation request.
// Budget middleware rejects requests that exceed this before touching OpenRouter.
// Free plan cap raised to $0.10 to accommodate GPT-5.6 Luna for trial users.

export const PER_REQUEST_COST_CAP_USD: Record<PlanId, number> = {
  free: 0.10,
  pro:  0.80,
};
