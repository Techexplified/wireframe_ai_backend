// ─── constants.ts — Plan configuration, credit packs, and app constants ───────
//
// Single source of truth for all plan limits and pricing configuration.
// Change values here, not scattered across routes.
//
// ARCHITECTURE:
//   • All pricing, rate limits, and quotas defined here for easy A/B testing
//   • Imported by services, controllers, and middleware
//   • Changes take effect on next function cold start (Firebase Functions restart cycle)
//   • Never modify these values in database; always in code (avoids sync issues)

// FREE_TRIAL_CREDITS — validated to prevent NaN / absurd values from a bad env.
// If the env value is non-numeric or out of the safe range [0, 50], falls back to 3.
// VALIDATION STRATEGY:
//   • parseInt() safe: returns NaN on non-numeric input → caught by Number.isFinite check
//   • Acceptable range: 0-50 credits (prevents config typos like 3000 or -5)
//   • Fallback: 3 credits as conservative default (enough for 3 generations on default model)
const _rawTrialCredits = parseInt(process.env.FREE_TRIAL_CREDITS || '3', 10);
export const FREE_TRIAL_CREDITS =
  Number.isFinite(_rawTrialCredits) && _rawTrialCredits >= 0 && _rawTrialCredits <= 50
    ? _rawTrialCredits
    : 3;

// ─── Plans ───────────────────────────────────────────────────────────────────
// Only two plans: 'free' (trial) and 'pro' ($20/month, 100 credits).
//
// PLAN STRATEGY:
//   • Free = trial-only, no subscription, immediate expiry (durationDays: 0)
//   • Pro = $20/month recurring via Dodo, auto-renewed (durationDays: 30)
//   • Plan ID embedded in Firebase custom claims + MongoDB UserDoc.plan field
//   • Subscription lifecycle: free → pro (checkout) → cancel or auto-renew
//
// CREDIT GRANT TIMING:
//   • Free plan: credited on first auth (see auth.middleware.ts)
//   • Pro plan: credited on webhook confirmation from Dodo (see webhookController.ts)
//   • Both plans can later purchase top-up packs for additional credits

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
//
// TOP-UP LOGIC:
//   • Free users cannot buy top-ups (require Pro subscription first)
//   • Pro users can purchase multiple packs per month (no limit enforced)
//   • Each pack adds to topup_credits field in UserDoc (separate from plan credits)
//   • Refunds must deduct from topup pool first, then plan pool (LIFO)
//   • Packs purchased but not used before subscription cancellation: lost (no refund)
//
// PRICING:
//   • Small: $5 → 20 credits = $0.25/credit
//   • Medium: $10 → 50 credits = $0.20/credit (best value)
//   • Large: $20 → 100 credits = $0.20/credit (same as medium)

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
//   gemini-3-7        → 2 credits (Google Gemini 3.7 Flash)
//
// CREDIT COST STRATEGY:
//   • Costs do NOT match actual OpenRouter pricing (see MODEL_PRICING below)
//   • Credits are a unit of scarcity, not direct cost passthrough
//   • E.g., gpt-5.6-luna costs $0.10/M input + $0.60/M output, but charges 1 credit
//   • This allows us to:
//     - Offer generous pricing to users (1 credit ≈ $0.30 per 10k output tokens)
//     - Cross-subsidize from Pro subscription revenue ($20/mo = 100 credits)
//     - Absorb infrastructure costs (MongoDB, OpenRouter inference)
//
// FREE USER ROUTING:
//   • Free users ALWAYS use gpt-5.6-luna regardless of UI selection
//   • Enforced in aiService.ts before OpenRouter call
//   • Prevents free users from accessing more expensive models (gemini-3-7 at 2 credits)

export const MODEL_CREDIT_COST: Record<string, number> = {
  'gpt-5-6-luna':      1,
  'deepseek-v4-pro':   1,
  'gemini-3-7':        2,
};

// ─── AI Model Map ─────────────────────────────────────────────────────────────
// Maps user-facing model keys to OpenRouter model identifiers.

export const MODEL_MAP: Record<string, string> = {
  'gpt-5-6-luna':      'openai/gpt-5.6-luna',
  'deepseek-v4-pro':   'deepseek/deepseek-v4-pro',
  'gemini-3-7':        'google/gemini-3.7-flash',
};
export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
export const DEFAULT_MODEL_KEY = 'gpt-5-6-luna';

// ─── Model Pricing Table ──────────────────────────────────────────────────────
// USD cost per 1 million tokens (input / output).
// Used by telemetry to compute estimated cost per request.

export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'google/gemini-3.7-flash':       { inputPer1M: 0.10, outputPer1M: 0.40  },
  'openai/gpt-5.6-luna':           { inputPer1M: 0.10, outputPer1M: 0.60  },
  'deepseek/deepseek-v4-pro':      { inputPer1M: 0.44, outputPer1M: 0.87  },
};

// ─── AI Rate Limit Config ─────────────────────────────────────────────────────
// Sliding-window rate limit per user per plan.
//
// RATE LIMIT PURPOSE:
//   • Prevent abuse: users spamming generations to discover model behavior
//   • Free users: 1 request per 30s (aggressive, discourages abuse)
//   • Pro users: 3 requests per 10s (allows workflow: generate → refine → regenerate)
//
// IMPLEMENTATION:
//   • Stored in generation_rate_limits collection with TTL index (auto-cleanup)
//   • Checked in ai.routes.ts before forwarding to OpenRouter
//   • Returns 429 Too Many Requests if limit exceeded
//   • Client should implement exponential backoff on 429

export const RATE_LIMIT_CONFIG: Record<PlanId, { windowMs: number; maxRequests: number }> = {
  free: { windowMs: 30_000, maxRequests: 1 },  // 1 request / 30s
  pro:  { windowMs: 10_000, maxRequests: 3 },  // 3 requests / 10s
};

// ─── Daily Token Quota ────────────────────────────────────────────────────────
// Max TOTAL tokens (input + output + reasoning) per user per UTC day.
// Tracks full OpenRouter token consumption — not just output tokens — for
// accurate cost-based abuse prevention.
//
// QUOTA STRATEGY:
//   • Free: 50,000 tokens/day ≈ 10-15 generations on default model
//   • Pro: 500,000 tokens/day ≈ 100-150 generations on default model
//   • Prevents "token bomb" attacks (user sends enormous prompts or uses reasoning)
//   • UTC day boundary: 00:00-23:59 UTC, resets at midnight UTC
//
// QUOTA ENFORCEMENT:
//   • Checked in ai.routes.ts BEFORE generation (prevents partial charges)
//   • Compares totalTokens from previous generations vs DAILY_TOKEN_QUOTA
//   • Stored in daily_token_quotas collection with auto-reset TTL (2 days)
//   • If user hits quota, returns 402 Payment Required (semantic HTTP code)

export const DAILY_TOKEN_QUOTA: Record<PlanId, number> = {
  free: 50_000,
  pro:  500_000,
};

// ─── Per-Request Cost Cap ─────────────────────────────────────────────────────
// Maximum estimated USD cost allowed per single generation request.
// Budget middleware rejects requests that exceed this before touching OpenRouter.
//
// COST CAP PURPOSE:
//   • Prevents runaway charges if user accidentally sends huge prompt
//   • Budget checked in checkout.rate-limit.middleware.ts
//   • Uses estimated cost from MODEL_PRICING + token budget inference
//   • Free plan cap raised to $0.10 to accommodate GPT-5.6 Luna for trial users
//   • Pro plan cap raised to $0.80 (covers ~500k output tokens at premium pricing)
//
// ESTIMATION STRATEGY:
//   • Pre-flight cost = MAX(estimatedInputCost, 2x) × MODEL_PRICING[model].outputPer1M
//   • Assumes worst case: user prompt is small, model returns max allowed tokens
//   • If pre-flight cost > cap, return 400 Bad Request before calling OpenRouter

export const PER_REQUEST_COST_CAP_USD: Record<PlanId, number> = {
  free: 0.10,
  pro:  0.80,
};
