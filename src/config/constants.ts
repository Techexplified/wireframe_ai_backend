// ─── constants.ts — Plan configuration, credit packs, and app constants ───────
//
// Single source of truth for all plan limits and pricing configuration.
// Change values here, not scattered across routes.

// FREE_TRIAL_CREDITS — validated to prevent NaN / absurd values from a bad env.
// If the env value is non-numeric or out of the safe range [0, 50], falls back to 3.
const _rawTrialCredits = parseInt(process.env.FREE_TRIAL_CREDITS || '3', 10);
export const FREE_TRIAL_CREDITS =
  Number.isFinite(_rawTrialCredits) && _rawTrialCredits >= 0 && _rawTrialCredits <= 50
    ? _rawTrialCredits
    : 3;

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
    priceLabel: '$5',
    priceId: process.env.DODO_PRODUCT_TOPUP_SMALL || '',
  },
  medium: {
    credits: 50,
    priceLabel: '$10',
    priceId: process.env.DODO_PRODUCT_TOPUP_MEDIUM || '',
  },
  large: {
    credits: 100,
    priceLabel: '$20',
    priceId: process.env.DODO_PRODUCT_TOPUP_LARGE || '',
  },
};

// ─── Feature Costs ────────────────────────────────────────────────────────────
// Default credit cost for generation (fallback when model key is unknown).
export const CREDIT_COST_GENERATE = 1;

// ─── AI Model Credit Cost Table ───────────────────────────────────────────────
//
// Credit deduction per generation:
//
//   gpt-5-6-luna      → 1 credit  (default / recommended)
//   deepseek-v4-pro   → 1 credit  (ultra-fast & intelligent)
//   gemini-2-7 / 3-7  → 2 credits (Google Gemini 2.7 / 3.7 Flash)
//   kimi-2-6          → 2 credits
//   gpt-4o            → 4 credits
//
// Free users are always routed to gpt-5.6-luna (1 credit/gen) regardless of selection.

export const MODEL_CREDIT_COST: Record<string, number> = {
  'gpt-5-6-luna':      1,
  'deepseek-v4-pro':   1,
  'gemini-3-7':        2,
  'gemini-2-7':        2,
  'kimi-2-6':          2,
  'gpt-4o':            4,
};

// ─── AI Model Map ─────────────────────────────────────────────────────────────
// Maps user-facing model keys to OpenRouter model identifiers.

export const MODEL_MAP: Record<string, string> = {
  'gpt-5-6-luna':      'openai/gpt-5.6-luna',
  'deepseek-v4-pro':   'deepseek/deepseek-v4-pro',
  'gemini-3-7':        'google/gemini-3.7-flash',
  'gemini-2-7':        'google/gemini-2.7-flash',
  'kimi-2-6':          'moonshotai/kimi-k2:free',
  'gpt-4o':            'openai/gpt-4o',
};
export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
export const DEFAULT_MODEL_KEY = 'gpt-5-6-luna';

// ─── Model Pricing Table ──────────────────────────────────────────────────────
// USD cost per 1 million tokens (input / output).
// Used by telemetry to compute estimated cost per request.

export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'moonshotai/kimi-k2:free':       { inputPer1M: 0,    outputPer1M: 0     },
  'google/gemini-3.7-flash':       { inputPer1M: 0.10, outputPer1M: 0.40  },
  'google/gemini-2.7-flash':       { inputPer1M: 0.10, outputPer1M: 0.40  },
  'openai/gpt-5.6-luna':           { inputPer1M: 0.10, outputPer1M: 0.60  },
  'deepseek/deepseek-v4-pro':      { inputPer1M: 0.44, outputPer1M: 0.87  },
  'openai/gpt-4o':                 { inputPer1M: 2.50, outputPer1M: 10.00 },
};

// ─── AI Rate Limit Config ─────────────────────────────────────────────────────
// Sliding-window rate limit per user per plan.

export const RATE_LIMIT_CONFIG: Record<PlanId, { windowMs: number; maxRequests: number }> = {
  free: { windowMs: 30_000, maxRequests: 1 },  // 1 request / 30s
  pro:  { windowMs: 10_000, maxRequests: 3 },  // 3 requests / 10s
};

// ─── Daily Token Quota ────────────────────────────────────────────────────────
// Max TOTAL tokens (input + output + reasoning) per user per UTC day.
// Tracks full OpenRouter token consumption — not just output tokens — for
// accurate cost-based abuse prevention.

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
