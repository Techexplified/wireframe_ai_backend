// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/subscriptions/subscription.routes.ts — Subscription Management Routes
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Manages user subscription lifecycle:
//   • Check current plan status (free vs. pro)
//   • View available credits
//   • Cancel pro subscription (downgrade to free)
//   • Reactivate pro subscription (upgrade back to pro)
//
// ROUTE MAP (mounted at /api/subscription):
//   GET  /status — retrieve user's plan state (Trigger A)
//   POST /cancel — downgrade pro user to free
//   POST /reactivate — upgrade free user back to pro
//
// WORKFLOW:
//   
//   GET /api/subscription/status (Trigger A):
//     1. User opens plugin, checks plan
//     2. Client sends GET /api/subscription/status
//     3. Server retrieves user document from MongoDB
//     4. Returns current plan state:
//        {
//          plan: \"pro\" | \"free\",
//          plan_credits: 1000,  // credits from current monthly subscription
//          topup_credits: 50,   // additional credits purchased via /checkout/topup
//          total_credits: 1050, // plan_credits + topup_credits
//          monthly_reset_date: \"2024-02-15T11:22:33Z\",
//          can_generate: true,  // determined by rate limit state
//          generations_this_hour: 2,
//          subscription_status: \"active\" | \"canceled\" | \"expired\",
//          subscription_ends_at: \"2024-02-15T23:59:59Z\"
//        }
//     5. Client displays plan badge and credit counter
//   
//   POST /api/subscription/cancel:
//     1. Pro user wants to downgrade to free
//     2. Client sends POST /api/subscription/cancel
//     3. Server calls Dodo API to cancel subscription
//     4. Dodo marks subscription as \"canceled\"
//     5. At end of billing cycle: user plan downgraded to \"free\"
//     6. User loses pro features but keeps existing topup credits
//     7. Response: { success: true, message: \"Subscription canceled\" }
//   
//   POST /api/subscription/reactivate:
//     1. User previously canceled, now wants pro again
//     2. Client sends POST /api/subscription/reactivate
//     3. Server calls Dodo API to reactivate subscription
//     4. Dodo resumes subscription billing
//     5. User regains pro features
//     6. Response: { success: true, message: \"Subscription reactivated\" }
//
// REQUEST/RESPONSE EXAMPLES:
//   
//   GET /api/subscription/status
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Response (200 OK):
//     {
//       \"plan\": \"pro\",
//       \"plan_credits\": 1000,
//       \"topup_credits\": 150,
//       \"total_credits\": 1150,
//       \"monthly_reset_date\": \"2024-02-15T23:59:59Z\",
//       \"can_generate\": true,
//       \"generations_this_hour\": 2,
//       \"subscription_status\": \"active\",
//       \"subscription_ends_at\": \"2024-03-15T23:59:59Z\"
//     }
//   
//   ---
//   
//   POST /api/subscription/cancel
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Request body: {} (empty)
//   
//   Response (200 OK):
//     {
//       \"success\": true,
//       \"message\": \"Subscription canceled\",
//       \"ends_at\": \"2024-03-15T23:59:59Z\",
//       \"feedback_collected\": false
//     }
//   
//   ---
//   
//   POST /api/subscription/reactivate
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Request body: {} (empty)
//   
//   Response (200 OK):
//     {
//       \"success\": true,
//       \"message\": \"Subscription reactivated\",
//       \"plan\": \"pro\",
//       \"plan_credits\": 1000
//     }
//
// PLAN STATES (users.plan field):
//   
//   \"free\":
//     • Default on signup
//     • 50 tokens per day quota
//     • Rate limit: 1 request per 30 seconds
//     • Per-request cap: $0.10
//     • No subscription billing
//     • All credits come from FREE_TRIAL_CREDITS constant
//   
//   \"pro\":
//     • After /checkout/init → Dodo webhook subscription.update
//     • 500k tokens per day quota
//     • Rate limit: 3 requests per 10 seconds
//     • Per-request cap: $0.80
//     • Monthly subscription billing via Dodo
//     • Can buy topup credits via /checkout/topup
//
// PLAN STATE COMPUTATION (PlanState type):
//   
//   Stored in request context (req.planState) by authMiddleware:
//     {
//       plan: \"free\" | \"pro\",
//       plan_credits: number,
//       topup_credits: number,
//       daily_token_quota: number,
//       tokens_used_today: number,
//       tokens_remaining: number,
//       rate_limit_window: \"30s\" | \"10s\",
//       rate_limit_max: number,
//       rate_limit_used: number,
//       per_request_cap_usd: number
//     }
//   
//   Computed from:
//     • users.plan (\"free\" vs. \"pro\")
//     • users.plan_credits, users.topup_credits
//     • PLAN_CONFIG constants (rate limits, quotas, caps)
//     • daily_token_quotas collection (tokens used today)
//     • generation_rate_limits collection (requests this window)
//
// CREDIT SYSTEM:
//   
//   Two types of credits:
//     1. plan_credits
//        • Allocated monthly with pro subscription
//        • Reset every month on billing date
//        • If not used by end of month, forfeited (no rollover)
//     2. topup_credits
//        • Purchased via /checkout/topup
//        • Don't expire (permanent)
//        • Consumed first (plan_credits used after topup empty)
//   
//   Credit consumption order:
//     1. Generate request arrives
//     2. Budget middleware estimates cost (via complexity scoring)
//     3. Reserve credits atomically (prevent double-charge)
//        • Try to deduct from topup_credits first
//        • If insufficient, deduct from plan_credits
//        • Atomic transaction (MongoDB session)
//     4. Stream generation to client
//     5. After completion:
//        • Actual token count known from OpenRouter
//        • Settle reservation (update to actual cost)
//        • If generated fewer tokens than estimated, refund difference
//     6. If generation fails mid-stream:
//        • Client calls /generate/refund
//        • Refund amount taken from credit_reservations
//        • Credits returned to user account
//
// STATUS ENDPOINT USAGE:
//   
//   When plugin loads:
//     • Client calls GET /status
//     • Server returns planState
//     • Plugin displays plan badge (\"Free\" or \"Pro\")
//     • Plugin displays credit counter (e.g., \"995 credits\")
//     • Plugin enables/disables /generate/start based on can_generate
//   
//   Before user generates:
//     • Client calls POST /generate/check
//     • Same guards as /start, but no credit deduction
//     • Returns can_generate: true/false with reason
//     • If false, plugin shows error message and disables generate button
//   
//   After user generates:
//     • Client gets X-Credits-Left header from /generate/start stream
//     • Plugin updates credit counter dynamically
//     • If credits go to 0, disable generate button
//     • Suggest topup via POST /checkout/topup
//
// ERROR HANDLING:
//   
//   Authentication failed (401):
//     { error: \"unauthorized\", message: \"Invalid or expired token\" }
//   
//   User not found (404):
//     { error: \"not_found\", message: \"User not found\" }
//   
//   Dodo API error on cancel/reactivate (502):
//     { error: \"subscription_error\", message: \"Failed to update subscription\" }
//   
//   Already canceled (409):
//     { error: \"conflict\", message: \"Subscription already canceled\" }
//
// MIDDLEWARE:
//   
//   All three routes require authMiddleware:
//     • Verifies Firebase JWT
//     • Binds figmaUserId to firebaseUid
//     • Loads user's plan state into req.planState
//     • Creates user if new (first-time signup)
//
// DODO INTEGRATION:
//   
//   cancel: calls dodo.provider.ts → cancelSubscription(userId, subscriptionId)
//   reactivate: calls dodo.provider.ts → reactivateSubscription(userId, subscriptionId)
//   
//   Dodo handles:
//     • Billing lifecycle (immediate vs. end-of-cycle)
//     • Webhook callback (already-processed, idempotent)
//     • Subscription state management

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import {
  getSubscriptionStatusHandler,
  cancelSubscriptionHandler,
  reactivateSubscriptionHandler,
} from './subscription.controller';

const router = Router();

router.get(
  '/status',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    getSubscriptionStatusHandler(req, res).catch(next);
  }
);

router.post(
  '/cancel',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    cancelSubscriptionHandler(req, res).catch(next);
  }
);

router.post(
  '/reactivate',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    reactivateSubscriptionHandler(req, res).catch(next);
  }
);

export default router;
