// ─── config/user.model.ts — MongoDB document type definitions ─────────────────
//
// All TypeScript interfaces that describe documents stored in MongoDB.
// Kept separate from the connection logic so modules can import types
// without importing (and thus executing) the MongoClient setup.
//
// ARCHITECTURE:
//   • Single source of truth for all 9 collection schemas
//   • Imported by routes, services, and middleware for type safety
//   • TypeScript compilation validates schema usage at build time
//   • Runtime validation: optional (not done in this codebase)
//
// COLLECTION RELATIONSHIPS:
//   users ← usage_logs (per-user audit trail)
//   users ← ai_requests_log (per-user telemetry)
//   users ← credit_reservations (pending credit deductions)
//   users ← daily_token_quotas (per-user token budget)
//   users ← feedbacks (user submissions)
//   webhook events → processed_webhooks (idempotency)
//   rate limit queries ← generation_rate_limits (sliding window)
//   rate limit queries ← checkout_rate_limits (sliding window)
//
// DENORMALIZATION NOTES:
//   • No foreign key constraints in MongoDB (eventual consistency)
//   • If user is deleted, orphaned docs remain (TTL cleanup eventually)
//   • Plan info stored in UserDoc to avoid join on every generation

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Users collection ───────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
// 
// Core user account document. Stores identity, plan, credits, and subscription state.
//
// Key interactions:
//   • Created by auth.middleware.ts on first user login
//   • Updated by webhook processing (subscription status, credits)
//   • Queried by every generation request (check plan, credits, rate limit)
//   • Joined with usage_logs for user audit history
//

export interface PaymentAttemptInfo {
  payment_id?: string;
  status: 'failed' | 'succeeded';
  error_code?: string;
  error_message?: string;
  failed_at?: Date;
}

export interface UserDoc {
  // ─ IDENTITY ─────────────────────────────────────────────────────────────────
  figmaUserId: string;                    // Primary key: UUID from Figma plugin
  // ─ SECURITY & AUTHENTICATION ───────────────────────────────────────────────
  client_secret_hash?: string;            // SHA-256 hash of device secret from figma.clientStorage
                                          //   Guarantees zero-trust session authentication
  firebaseUid?: string;                   // Firebase Anonymous UID bound on first auth
                                          //   Sparse index: only set for users who logged in via Firebase
                                          //   Used by auth.middleware.ts to look up user by Firebase UID
  name?: string;                          // Display name (optional, from Figma profile)
  
  // ─ PLAN & CREDITS ──────────────────────────────────────────────────────────
  plan: 'free' | 'pro';                   // Current plan: 'free' (trial) or 'pro' (paid subscription)
                                          //   Used by every generation request to check rate limits & quotas
  credits: number;                        // Plan pool credits (deducted when plan duration active)
                                          //   Range: 0-1000 (plan grants 100 on pro, 3-50 on free)
  topup_credits: number;                  // Top-up pool credits (purchased via checkout)
                                          //   Range: 0-1000000 (no hard limit)
                                          //   Refund strategy: LIFO (refund from topup first, then plan)
  
  // ─ SUBSCRIPTION LIFECYCLE ───────────────────────────────────────────────────
  subscription_started_at: Date | null;   // When subscription activated (first Dodo webhook success)
                                          //   null = free user or subscription not yet activated
  subscription_ends_at: Date | null;      // When subscription expires (next billing date or cancellation date)
                                          //   null = free user or subscription not yet activated
                                          //   Check: if (now > subscription_ends_at) then downgrade to free
  dodo_subscription_id?: string | null;   // Dodo payment provider subscription ID
                                          //   null = free user or Dodo subscription not created
                                          //   Used to link user to Dodo webhook events
  subscription_cancelled?: boolean;       // True if user cancelled (but grace period may still be active)
                                          //   Even if cancelled, can still use credits until subscription_ends_at
  
  // ─ PAYMENT TRACKING ────────────────────────────────────────────────────────
  last_payment_attempt?: PaymentAttemptInfo | null; // Last checkout attempt result
                                          //   Used for error messages & debugging
  
  // ─ TIMESTAMPS ───────────────────────────────────────────────────────────────
  createdAt: Date;                        // Account creation timestamp (when user first logged in)
  updatedAt?: Date;                       // Last modification timestamp (optional, set by updateOne)
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Processed webhooks collection ──────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Idempotency ledger: prevents double-processing of Dodo payment webhooks.
//
// Webhook flow:
//   1. Dodo sends webhook → webhookController.ts receives it
//   2. Check: db.processed_webhooks.findOne({ eventId })
//   3. If found (already processed) → return 200 (HTTP success, no action)
//   4. If not found (first time) → process webhook (update user, grant credits)
//   5. Insert into processed_webhooks to mark as processed
//
// Why needed?
//   • Dodo may retry webhook on network failure (up to 3 times)
//   • Client may retry if network timeout occurs
//   • Without idempotency: user gets credited multiple times for same purchase
//   • TTL (90 days) handles retry window, then auto-cleanup
//

export interface ProcessedWebhookDoc {
  eventId: string;                        // Unique webhook event ID from Dodo (UUIDv4)
                                          // Unique index ensures only one record per event
  processedAt: Date;                      // Timestamp when webhook was processed
                                          // Used by TTL index: delete after 90 days
  status: 'processing' | 'completed' | 'failed'; // Processing status
                                          //   'processing' = webhook handler started (prevent race)
                                          //   'completed' = webhook handler finished successfully
                                          //   'failed' = webhook handler threw error (debug needed)
  updatedAt?: Date;                       // Last status update timestamp
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Checkout Rate Limits collection (`checkout_rate_limits`) ────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Sliding window rate limit for checkout endpoint (prevent brute force).
// Allows max 3 checkout attempts per user per 2 minutes.
//
// Query: db.checkout_rate_limits.countDocuments({ figmaUserId, requestedAt: {$gt: now - 120s} })
// If count >= 3 → reject with 429 Too Many Requests
// If count < 3 → allow checkout attempt, insert new doc
//
// TTL: 120s (auto-cleanup of old rate limit records)
//

export interface CheckoutRateLimitDoc {
  figmaUserId: string;                    // User attempting checkout
  requestedAt: Date;                      // Timestamp of checkout attempt
                                          // Used by TTL index: delete after 120s
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Credit Reservations collection ──────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Fix CREDIT-C-01: Server-side record of each credit deduction.
// Prevents double-charging and enables refunds by reference (not client-supplied amount).
//
// Atomic credit deduction workflow:
//   1. User initiates generation → POST /ai/generate
//   2. ai.routes.ts creates CreditReservationDoc (status: 'pending')
//   3. Deducts credits from user's plan/topup pools atomically
//   4. Calls OpenRouter API to generate content
//   5. On success → update reservation (status: 'settled')
//   6. On failure → update reservation (status: 'refunded'), credit user back
//   7. After 10 min → TTL removes expired 'pending' reservations (cleanup)
//
// Why server-side tracking?
//   • Client cannot trusted to send amount (could say "cost 0 credits")
//   • Server computes actual cost before generation
//   • Refund refs reservationId, not user-supplied amount
//   • Prevents credit fraud (users refunding more than they spent)
//
// TTL cleanup (10 minutes):
//   • Prevents stale 'pending' reservations from blocking refunds
//   • If generation fails mid-flight, reservation expires → auto-cleanup
//   • Refund window: admin can manually refund settled reservations anytime
//

export interface CreditReservationDoc {
  reservationId: string;    // UUIDv4: unique identifier for this credit deduction
                            // Sent to client as X-Reservation-Id header (for future refunds)
                            // Unique index: only one reservation per reservationId
  figmaUserId:   string;    // User whose credits are reserved
  cost:          number;    // Authoritative credit cost from server
                            // Computed by aiService.ts based on model selection
                            // Refund amount must equal this (client cannot override)
  pool:          'plan' | 'topup'; // Which credit pool was deducted
                            //   'plan' = subscription monthly credits (expires when subscription ends)
                            //   'topup' = purchased credits (no expiry, refundable)
  status:        'pending' | 'settled' | 'refunded'; // Processing status
                            //   'pending' = generation in flight, not yet confirmed
                            //   'settled' = generation completed, credits spent
                            //   'refunded' = user refunded, credits restored to pool
  reservedAt:    Date;      // When reservation was created (timestamp of generation request)
  expiresAt:     Date;      // When TTL will auto-delete this doc (reservedAt + 10 min)
                            // TTL index: MongoDB daemon deletes docs when current time >= expiresAt
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Usage logs collection ────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Audit trail: record of every credit deduction.
// Used for user support ("can you refund this?"), billing disputes, and analytics.
//
// Log timing:
//   • Inserted by aiService.ts AFTER OpenRouter returns successfully
//   • One log per generation (no logs for failed/rejected generations)
//   • Indexed by figmaUserId for quick "user's credit history" queries
//
// Refund eligibility:
//   • Logs older than 30 days cannot be refunded (policy cutoff)
//   • Links to credit_reservations via reservationId (enables refund)
//   • TTL cleanup: logs deleted after 180 days (compliance/storage)
//

export interface UsageLogDoc {
  figmaUserId:    string;             // User who spent credits
  action:         string;             // Action type (e.g., 'generation', 'refund')
                                      // Used for filtering: "show only generations" vs "show refunds"
  creditsUsed:    number;             // Number of credits deducted
                                      // Matched against cost in credit_reservations for audit
  pool:           'plan' | 'topup';  // Fix CREDIT-H-01: which pool was deducted
                                      //   'plan' = subscription credits (may expire)
                                      //   'topup' = purchased credits (refundable)
  reservationId?: string;            // Fix CREDIT-H-01: links to credit_reservations doc
                                      // Used to look up original reservation for refund details
  promptSnippet?: string;            // First N characters of user prompt (optional, for debugging)
                                      // Sanitized to remove PII before insertion
  timestamp:      Date;               // When credit was deducted (UTC)
                                      // Used by TTL index: delete after 180 days
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── AI Telemetry collection (`ai_requests_log`) ────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Telemetry: detailed metrics from each OpenRouter API call.
// Used for cost tracking, performance monitoring, and ML model analysis.
//
// Logged by: aiService.ts after OpenRouter returns response
// Stored for: 90 days (covers monthly billing cycle + buffer)
// Query pattern: "user's last 5 requests", "cost per model", "token distribution"
//
// Cost estimation:
//   • estimatedCostUSD computed from MODEL_PRICING + token counts
//   • Not 100% accurate (depends on OpenRouter's actual token count)
//   • Used to warn users approaching daily token quota
//   • Basis for cost cap budget middleware (prevent runaway charges)
//

export interface AiRequestLogDoc {
  figmaUserId:      string;             // User who initiated the generation
  model:            string;             // Model used (e.g., 'openai/gpt-5.6-luna')
  promptTokens:     number;             // Tokens in user's prompt
  completionTokens: number;             // Tokens in model's response
  reasoningTokens:  number;             // Tokens used for model reasoning (e.g., o1, chain-of-thought)
  totalTokens:      number;             // promptTokens + completionTokens + reasoningTokens
                                        // Used by daily_token_quotas to check quota
  estimatedCostUSD: number;             // Estimated cost of this request
                                        // = (promptTokens * MODEL_PRICING[model].inputPer1M) +
                                        //   (completionTokens * MODEL_PRICING[model].outputPer1M)
  finishReason:     string;             // OpenRouter finish reason (e.g., 'stop', 'max_tokens', 'content_filter')
  durationMs:       number;             // Time from request sent to response received (milliseconds)
                                        // Used for performance monitoring (alert if > 60s)
  complexityScore:  number;             // Internal scoring: how complex was this request?
                                        // Used for ML analysis (what patterns cause slow requests?)
  tokenBudget:      number;             // Max tokens user is willing to use in response
                                        // Used to control output length (prevent runaway costs)
  timestamp:        Date;               // When request was made (UTC)
                                        // Used by TTL index: delete after 90 days
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Generation Rate Limits collection (`generation_rate_limits`) ───────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Sliding window rate limit for AI generation endpoint.
// Prevents abuse (spam generation to discover model behavior).
//
// Rate limit policy:
//   • Free users: 1 request per 30 seconds
//   • Pro users: 3 requests per 10 seconds
// (Configured in constants.ts RATE_LIMIT_CONFIG)
//
// Query pattern (ai.routes.ts):
//   1. db.generation_rate_limits.countDocuments({ figmaUserId, requestedAt: {$gt: now - windowMs} })
//   2. If count >= maxRequests → return 429 Too Many Requests
//   3. If count < maxRequests → insert new doc, process generation
//
// TTL cleanup: 120 seconds (covers max window size)
//

export interface RateLimitDoc {
  figmaUserId: string;                    // User making the request
  requestedAt: Date;                      // Timestamp of request
                                          // Used to compute sliding window: count docs where requestedAt > now - windowMs
                                          // TTL index deletes after 120s (cleanup old rate limit records)
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Daily Token Quotas collection (`daily_token_quotas`) ───────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Daily token budget tracking: limit total tokens per user per UTC day.
// Prevents users from burning monthly token quota in one day.
//
// Token quota policy:
//   • Free users: 50,000 tokens per UTC day
//   • Pro users: 500,000 tokens per UTC day
// (Configured in constants.ts DAILY_TOKEN_QUOTA)
//
// Quota reset timing:
//   • UTC day boundary: resets at 00:00:00 UTC (not user's local time)
//   • One document per user per calendar day
//   • Upsert operation: find or create atomically
//
// Query pattern (ai.routes.ts before generation):
//   1. db.daily_token_quotas.findOne({ figmaUserId, date: todayUTC })
//   2. If found: check tokensUsed + newTokens <= quota
//   3. If not found: first generation today, create doc
//   4. On success: increment tokensUsed by actual token count
//   5. If quota exceeded: return 402 Payment Required (no retry suggested)
//
// TTL cleanup: 2 days (covers UTC day boundary variance)
//

export interface DailyQuotaDoc {
  figmaUserId: string;        // User making generation requests
  date:        string;        // YYYY-MM-DD UTC (calendar day in UTC, e.g., "2024-01-15")
                              // Unique constraint: one document per user per date
  tokensUsed:  number;        // Total tokens consumed today (input + output + reasoning)
                              // Atomically incremented after each generation
  createdAt:   Date;          // When this daily quota record was created
                              // Used by TTL index: delete after 2 days (172800 seconds)
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── Feedbacks collection (`feedbacks`) ─────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════
//
// User feedback submissions: collected from plugin UI for product improvement.
// Used by product team to identify feature requests, bugs, and user sentiment.
//
// Submission endpoint: POST /feedback (requires user to be authenticated)
// Data retention: indefinite (kept for compliance and historical analysis)
// Analysis: queried by dashboard for sentiment distribution and trend analysis
//
// Index usage:
//   • By timeline: createdAt (newest feedback first)
//   • By user: figmaUserId + createdAt (user's feedback history)
//   • By sentiment: rating + category (group for analytics)
//

export interface FeedbackDoc {
  figmaUserId:   string;                  // User who submitted feedback
  userName?:     string;                  // Display name (optional, from Figma profile)
  userEmail?:    string;                  // Contact email (optional, for follow-up)
  plan:          'free' | 'pro';          // User's plan at submission time
                                          // Used for segmentation: "what do pro users complain about?"
  rating:        number;                  // 1-5 star rating (1=terrible, 5=excellent)
                                          // Indexed for sentiment distribution analysis
  category:      string;                  // Feedback type (e.g., 'bug', 'feature-request', 'general')
                                          // Used for filtering by team (engineers for bugs, PM for features)
  message?:      string;                  // User's feedback text (free-form)
                                          // May contain PII or product feedback
  context?: {                             // Optional context when feedback submitted
    lastPrompt?:    string;               // Most recent prompt (sanitized)
    selectedModel?: string;               // Model user was using
    platform?:      'desktop' | 'mobile'; // Plugin platform (web or mobile Figma)
    style?:         string;               // UI style preference
  };
  pluginVersion: string;                  // Plugin version at submission time
                                          // Used to trace bugs to specific releases
  status:        'new' | 'reviewed' | 'in_progress' | 'resolved'; // Triage status
                                          //   'new' = unreviewed by team
                                          //   'reviewed' = assigned to owner
                                          //   'in_progress' = fix/response being worked on
                                          //   'resolved' = addressed and communicated to user
  createdAt:     Date;                    // When feedback was submitted (UTC)
  updatedAt:     Date;                    // Last status update (UTC)
}

// ═════════════════════════════════════════════════════════════════════════════════
// ─── IP Rate Limits collection ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════
//
// Anti-abuse ledger: tracks IP-based actions (account creation, trial generation)
// to prevent Sybil bot farms and DDoS attacks.
//

export interface IpRateLimitDoc {
  clientIp:   string;                     // Client IP address (sanitized)
  action:     string;                     // Action type ('account_create', 'free_gen', etc.)
  timestamp:  Date;                       // Action timestamp
  metadata?:  Record<string, unknown>;    // Optional context (figmaUserId, etc.)
}
