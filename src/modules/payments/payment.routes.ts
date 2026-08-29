// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/payments/payment.routes.ts — Checkout Routes (Triggers C & D)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Manages payment checkout flows:
//   • Trigger C: User upgrades from free → pro plan
//   • Trigger D: User buys additional credits (top-up)
//   
//   Both use Dodo Payments API for payment processing
//   Both redirect user to Dodo checkout page (external payment provider)
//   Both return webhook confirmation via POST /webhooks/dodo
//
// ROUTE MAP (mounted at /api/checkout):
//   POST /init  — initiate plan upgrade checkout (Trigger C)
//   POST /topup — initiate credit top-up checkout (Trigger D)
//
// WORKFLOW:
//   
//   POST /api/checkout/init (Plan Upgrade):
//     1. User on free plan wants to upgrade to pro
//     2. Client sends POST /api/checkout/init
//     3. Server calls dodoProvider.createPlanCheckout()
//     4. Dodo API returns checkout URL (e.g., https://checkout.dodo.com/session/123)
//     5. Server returns { checkout_url, session_id }
//     6. Client redirects browser to checkout URL (user enters payment info in Dodo)
//     7. User completes payment in Dodo
//     8. Dodo sends webhook: POST /webhooks/dodo with subscription.update event
//     9. Server marks user as pro (updates user.plan = 'pro')
//     10. User's new plan credits become available
//   
//   POST /api/checkout/topup (Credit Top-Up):
//     1. User on pro plan is low on credits (e.g., 5 left)
//     2. Client sends POST /api/checkout/topup?credits=100
//     3. Server calls dodoProvider.createTopUpCheckout()
//     4. Dodo API returns checkout URL for 100-credit package
//     5. Server returns { checkout_url, session_id }
//     6. Client redirects browser to Dodo checkout
//     7. User enters payment info in Dodo
//     8. Dodo sends webhook: POST /webhooks/dodo with payment.complete event
//     9. Server adds 100 credits to user.topup_credits
//     10. User can generate again
//
// MIDDLEWARE STACK:
//   
//   POST /init (Trigger C):
//     1. authMiddleware — verify identity, ensure user exists
//     2. checkoutRateLimitMiddleware — max 15 checkouts per 60s per user (Fix NEW-H-02)
//     3. initCheckoutHandler — create Dodo checkout session
//   
//   Why checkout rate limit?
//     • Prevents accidental double-clicks → double checkouts
//     • Prevents spam/abuse → malicious users creating 1000s of checkouts
//     • Limit: 15 per 60 seconds (generous for legitimate use)
//   
//   POST /topup (Trigger D):
//     1. authMiddleware — verify identity
//     2. requireProMiddleware — must be pro user (Fix AUTH-M-01)
//     3. checkoutRateLimitMiddleware — max 15 checkouts per 60s
//     4. topupCheckoutHandler — create Dodo top-up checkout session
//   
//   Why requirePro for /topup?
//     • Top-up is only for pro users (free users get plan credits)
//     • Free users should upgrade first via /init
//     • Prevents: free user using topup as sneaky upgrade path
//
// REQUEST/RESPONSE EXAMPLES:
//   
//   POST /api/checkout/init
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Request body:
//     { \"plan\": \"pro\" }  OR  {} (implied plan=pro)
//   
//   Response (200 OK):
//     {
//       \"checkout_url\": \"https://checkout.dodo.com/session/sess_123...\",
//       \"session_id\": \"sess_123\",
//       \"expires_in\": 1800,
//       \"error\": null
//     }
//   
//   ---
//   
//   POST /api/checkout/topup
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Request body:
//     { \"credits\": 100 }  // from TOPUP_PACKS in constants.ts
//   
//   Response (200 OK):
//     {
//       \"checkout_url\": \"https://checkout.dodo.com/session/sess_456...\",
//       \"session_id\": \"sess_456\",
//       \"amount_usd\": 9.99,
//       \"credits\": 100,
//       \"error\": null
//     }
//
// ERROR HANDLING:
//   
//   Checkout rate limit exceeded (429):
//     { error: \"rate_limit_exceeded\", message: \"Too many checkout attempts...\" }
//   
//   Not pro user on /topup (403):
//     { error: \"forbidden\", message: \"Only pro users can top-up credits...\" }
//   
//   Dodo API error (502):
//     { error: \"checkout_failed\", message: \"Payment system unavailable...\" }
//   
//   Invalid credits amount (400):
//     { error: \"bad_request\", message: \"Credits must be 100, 500, or 1000\" }
//
// CHECKOUT RATE LIMIT (Fix NEW-H-02):
//   
//   Implemented in checkoutRateLimitMiddleware:
//     • Sliding window rate limiter
//     • Max 15 checkouts per 60 seconds per user
//     • Stored in checkout_rate_limits collection (TTL=120s auto-cleanup)
//     • Returns 429 Too Many Requests if limit exceeded
//   
//   Why sliding window?
//     • More accurate than fixed windows
//     • Prevents: burst of 15 requests at 59s, then 15 more at 61s
//     • Sliding window: only 15 in any 60-second window
//   
//   Why TTL=120s?
//     • Keeps old entries for 2x the window (safety margin)
//     • Auto-cleanup prevents unbounded collection growth
//     • Small overhead: 1 document per checkout attempt
//
// WEBHOOK CONFIRMATION:
//   
//   After user completes payment in Dodo:
//     1. Dodo calls POST /webhooks/dodo with event_type=\"subscription.update\" (plan)
//                                  or event_type=\"payment.complete\" (topup)
//     2. webhook.controller.ts verifies signature (DODO_WEBHOOK_SECRET)
//     3. Checks idempotency (eventId) via markEventProcessed()
//     4. Processes event:
//        - subscription.update: sets user.plan = 'pro', updates user doc
//        - payment.complete: adds topup credits to user doc
//     5. Marks event as complete: completeEventProcessed()
//     6. Returns 200 OK (idempotent)
//   
//   What if webhook fails to reach server?
//     • Dodo retries for ~7 days
//     • Each retry calls POST /webhooks/dodo
//     • If already processed: markEventProcessed() returns false, webhook skipped (idempotent)
//     • User subscription/topup not duplicated
//
// SECURITY CONSIDERATIONS:
//   
//   1. HTTPS only
//      • All payment endpoints require HTTPS (Firebase enforces)
//      • Prevents man-in-the-middle attacks on checkouts
//   
//   2. Firebase JWT required
//      • authMiddleware verifies JWT on both endpoints
//      • Prevents: attackers creating checkouts for other users
//   
//   3. Checkout URL from Dodo
//      • Client redirects to Dodo, not our site
//      • Payment info entered in Dodo (PCI-DSS compliant, not our responsibility)
//      • Server never sees credit card (reduces liability)
//   
//   4. Webhook signature verification
//      • DODO_WEBHOOK_SECRET kept in env (never logged)
//      • Each webhook verifies HMAC signature
//      • Prevents: attackers faking webhooks to grant credits
//   
//   5. Idempotency with unique constraint
//      • Even if Dodo sends duplicate webhooks, processed at most once
//      • Prevents: double-charging via duplicate webhook
//
// PRICING:
//   
//   Plan upgrade (/init):
//     Free users only, charges subscription fee per month
//     Amount in Dodo product configuration
//   
//   Credit top-up (/topup):
//     Pro users only, packages:
//       100 credits = $2.99  (TOPUP_PACKS[0])
//       500 credits = $9.99  (TOPUP_PACKS[1])
//       1000 credits = $19.99 (TOPUP_PACKS[2])
//     
//     Prices set in constants.ts and synced with Dodo products
//
// DODO API INTEGRATION:
//   
//   See dodo.provider.ts for implementation details:
//     • createPlanCheckout(userId, plan) → checkout URL
//     • createTopUpCheckout(userId, credits) → checkout URL
//     • verifyWebhookSignature(req) → true/false
//     
//   All Dodo calls timeout after 10 seconds (prevents hangs)

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { checkoutRateLimitMiddleware } from '../../middleware/checkout.rate-limit.middleware';
import { requireProMiddleware } from '../../middleware/require-pro.middleware';
import { initCheckoutHandler, topupCheckoutHandler } from './payment.controller';

const router = Router();

router.post(
  '/init',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkoutRateLimitMiddleware(req, res, next).catch(next);
  },
  (req: Request, res: Response, next: NextFunction) => {
    initCheckoutHandler(req, res).catch(next);
  }
);

router.post(
  '/topup',
  authMiddleware,
  requireProMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkoutRateLimitMiddleware(req, res, next).catch(next);
  },
  (req: Request, res: Response, next: NextFunction) => {
    topupCheckoutHandler(req, res).catch(next);
  }
);

export default router;
