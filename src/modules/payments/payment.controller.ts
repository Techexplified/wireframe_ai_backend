// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/payments/payment.controller.ts — Checkout Session Initiators
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   HTTP handlers for two checkout endpoints:\n//     1. POST /api/checkout/init (plan upgrade)\n//     2. POST /api/checkout/topup (credit purchase)\n//   Responsible for: validating checkout requests, calling Dodo API, returning checkout URLs\n//   NOT responsible for: payment processing (done by Dodo), webhook handling (done by webhook.controller)\n//\n// TWO CHECKOUT FLOWS:\n//   \n//   Flow 1: Plan Upgrade (Trigger C)\n//     • User: \"I want to upgrade to Pro\"\n//     • POST /api/checkout/init { planId: 'pro' }\n//     • initCheckoutHandler:\n//       1. Validate: planId = 'pro' (only option)\n//       2. Check: not already pro with active auto-renewal\n//       3. Call: createPlanCheckout(figmaUserId, 'pro', topup_credits, days_left)\n//       4. Return: { checkoutUrl, checkoutId }\n//     • Client: redirect to checkoutUrl (Dodo hosted page)\n//     • User: enters credit card on Dodo\n//     • Dodo: processes payment, sends webhook\n//     • webhook.controller: updates user.plan='pro'\n//     • Result: user now pro! ✓\n//   \n//   Flow 2: Credit Top-Up (Trigger D)\n//     • User: \"I need more credits\"\n//     • Selects pack: small (100 credits), medium (500 credits), large (1000 credits)\n//     • POST /api/checkout/topup { packId: 'medium' }\n//     • topupCheckoutHandler:\n//       1. Validate: isActive (must be pro)\n//       2. Validate: packId in ['small', 'medium', 'large']\n//       3. Call: createTopUpCheckout(figmaUserId, 'medium')\n//       4. Return: { checkoutUrl, checkoutId, pack_info }\n//     • Client: redirect to checkoutUrl\n//     • User: enters card (or uses saved card)\n//     • Dodo: processes payment, sends webhook\n//     • webhook.controller: updates user.topup_credits += 500\n//     • Result: user has 500 more credits! ✓\n//\n// INITCHECKOUTHANDLER LOGIC (Trigger C):\n//   \n//   Step 1: Parse request\n//     • Extract: planId from req.body\n//     • Expected: planId='pro' (only option)\n//   \n//   Step 2: Validate planId\n//     • Check: planId exists and = 'pro'\n//     • If not: return 400 \"invalid_plan\"\n//     • Why validate? Prevent typos/future expansion\n//   \n//   Step 3: Check current subscription (FIX-C-01)\n//     • Extract: plan, isActive, subscription_cancelled from planState\n//     • FIX-C-01: allow re-subscription if user canceled auto-renewal\n//     • Logic:\n//       - If: isActive + currentPlan='pro' + subscription_cancelled=false\n//         → return 409 Conflict (already pro, not canceled)\n//       - Otherwise: allow checkout\n//     • Why? User can upgrade, re-subscribe after cancel, or stay free\n//   \n//   Step 4: Validate configuration\n//     • Check: PLAN_CONFIG['pro'].priceId exists\n//     • Check: DODO_API_KEY environment variable set\n//     • If missing: return 500 \"configuration_error\"\n//     • Why? Checkout can't work without config\n//   \n//   Step 5: Call Dodo API\n//     • createPlanCheckout(figmaUserId, 'pro', topup_credits, days_left)\n//     • Dodo returns: { checkoutUrl, checkoutId }\n//     • On error: catch and return 502 Bad Gateway\n//   \n//   Step 6: Return response\n//     • 200 OK { checkoutUrl, checkoutId }\n//     • Client redirects browser to checkoutUrl\n//   \n//   Example successful response:\n//     {\n//       checkoutUrl: \"https://test.dodopayments.com/checkouts/sess_abc123\",\n//       checkoutId: \"sess_abc123\"\n//     }\n//   \n//   Example error response (already pro):\n//     {\n//       error: {\n//         message: \"You are already on the Pro plan with active auto-renewal.\",\n//         code: \"already_on_plan\"\n//       },\n//       status: 409\n//     }\n//\n// TOPUPCHECKOUTHANDLER LOGIC (Trigger D):\n//   \n//   Step 1: Parse request\n//     • Extract: packId from req.body\n//     • Expected: packId in ['small', 'medium', 'large']\n//   \n//   Step 2: Authorization (must be pro)\n//     • Check: isActive from planState\n//     • If not: return 403 \"plan_required\"\n//     • Why? Top-up is for pro users only (free users upgrade instead)\n//   \n//   Step 3: Validate packId\n//     • Check: packId is one of ['small', 'medium', 'large']\n//     • If not: return 400 \"invalid_pack\"\n//   \n//   Step 4: Validate configuration\n//     • Check: TOPUP_PACKS[packId].priceId exists\n//     • If missing: return 500 \"configuration_error\"\n//   \n//   Step 5: Call Dodo API\n//     • createTopUpCheckout(figmaUserId, packId)\n//     • Dodo returns: { checkoutUrl, checkoutId }\n//     • On error: catch and return 502 Bad Gateway\n//   \n//   Step 6: Return response\n//     • 200 OK { checkoutUrl, checkoutId, pack_info }\n//     • pack_info: { credits: 500, price: \"$9.99\" }\n//     • Client uses: to show user summary (\"Buy 500 credits for $9.99?\")\n//   \n//   Example successful response:\n//     {\n//       checkoutUrl: \"https://test.dodopayments.com/checkouts/sess_def456\",\n//       checkoutId: \"sess_def456\",\n//       pack_info: {\n//         credits: 500,\n//         price: \"$9.99\"\n//       }\n//     }\n//\n// TOPUP PACK STRUCTURE (constants.ts):\n//   \n//   TOPUP_PACKS = {\n//     'small': {\n//       credits: 100,\n//       price: 1.99,\n//       priceLabel: '$1.99',\n//       priceId: 'prod_topup_100_1_99'  // Dodo product ID\n//     },\n//     'medium': {\n//       credits: 500,\n//       price: 9.99,\n//       priceLabel: '$9.99',\n//       priceId: 'prod_topup_500_9_99'\n//     },\n//     'large': {\n//       credits: 1000,\n//       price: 19.99,\n//       priceLabel: '$19.99',\n//       priceId: 'prod_topup_1000_19_99'\n//     }\n//   }\n//   \n//   Why separate priceId for each pack?\n//     • Dodo: tracks inventory and revenue by product\n//     • Each pack: separate product ID in Dodo dashboard\n//     • This controller: maps pack → priceId → Dodo checkout\n//\n// PLANSTATE STRUCTURE (from auth.middleware):\n//   \n//   planState = {\n//     plan: 'free' | 'pro',          // current plan\n//     isActive: boolean,              // plan expires in future?\n//     credits: number,                // monthly allocation (resets monthly)\n//     topup_credits: number,          // purchased credits (unlimited)\n//     days_left: number,              // until subscription expires\n//     subscription_ends_at: Date,     // exact expiration time\n//     subscription_cancelled: boolean, // scheduled to cancel at period end?\n//     last_payment_attempt: object    // last payment result\n//   }\n//   \n//   Computed by: auth.middleware (user.service.computePlanState)\n//   Cached by: per-request (single HTTP request)\n//   Used by: all endpoints for authorization\n//\n// CHECKOUTURL FLOW (what happens after we return it?):\n//   \n//   1. Server returns: { checkoutUrl: \"https://test.dodopayments.com/checkouts/sess_abc123\" }\n//   2. Client (Figma plugin) calls: window.open(checkoutUrl)\n//   3. Browser: opens new window, navigates to Dodo\n//   4. Dodo: displays hosted checkout form\n//   5. User: enters credit card details\n//   6. Dodo: validates card, processes payment (~5 seconds)\n//   7. Success: Dodo redirects to success_url (configured in Dodo dashboard)\n//   8. Dodo: sends webhook to /webhooks/dodo (async, ~1 second delay)\n//   9. webhook.controller: receives webhook, updates user.plan='pro'\n//   10. Plugin: (if user closed window) next API call hits /status, sees plan='pro'\n//   11. Plugin: updates UI to show pro features\n//   \n//   Why return both checkoutUrl and checkoutId?\n//     • checkoutUrl: for user to pay\n//     • checkoutId: for server to reference if client asks \"is payment done?\"\n//     • Not used in current flow (we rely on webhook)\n//     • Useful for polling pattern (if client polls instead of webhook)\n//\n// ERROR SCENARIOS:\n//   \n//   Scenario A: User tries to upgrade while already pro\n//     • initCheckoutHandler checks: isActive + plan='pro' + subscription_cancelled=false\n//     • Returns: 409 Conflict \"already on plan\"\n//   \n//   Scenario B: Free user tries to topup\n//     • topupCheckoutHandler checks: isActive\n//     • Returns: 403 Forbidden \"plan_required\"\n//   \n//   Scenario C: Dodo API is down\n//     • createPlanCheckout throws: AxiosError\n//     • Caught by: try-catch in controller\n//     • Returns: 502 Bad Gateway \"checkout_failed\"\n//     • Client: shows error, user can retry\n//   \n//   Scenario D: DODO_API_KEY environment variable missing\n//     • Check: if (!process.env.DODO_API_KEY)\n//     • Returns: 500 \"configuration_error\"\n//     • Indicates: server misconfiguration (admin should fix)\n//   \n//   Scenario E: User submits invalid packId\n//     • topupCheckoutHandler checks: packId in ['small', 'medium', 'large']\n//     • Returns: 400 \"invalid_pack\"\n//     • Possible: client bug, or malicious request\n//\n// METADATA PASSED TO DODO:\n//   \n//   initCheckoutHandler passes:\n//     • figmaUserId: identify user after payment\n//     • planId: 'pro'\n//     • paymentType: 'subscription' (webhook uses this)\n//     • existing_topup_credits: snapshot before upgrade\n//     • existing_days_left: snapshot before upgrade\n//   \n//   topupCheckoutHandler passes:\n//     • figmaUserId: identify user after payment\n//     • packId: 'small', 'medium', or 'large'\n//     • paymentType: 'topup' (webhook uses this)\n//   \n//   Why metadata?\n//     • Webhook has full context (doesn't need to query DB again)\n//     • Dodo returns metadata in webhook payload\n//     • webhook.controller uses: to identify user and action\n//\n// RATE LIMITING:\n//   \n//   No explicit rate limiting on these endpoints\n//   But: checkout.rate-limit.middleware is applied\n//     • Max 15 checkout attempts per 60 seconds\n//     • Prevents: spamming checkout (accidental or malicious)\n//     • Tracks: by figmaUserId + endpoint\n//   \n//   Result: user can't spam checkouts (would get 429 Too Many Requests)\n//\n// FUTURE IMPROVEMENTS:\n//   \n//   1. Checkout upsells: \"Upgrade to annual plan, save 20%\"\n//   2. Checkout analytics: track conversion rates\n//   3. Checkout error recovery: \"Card declined? Try again with new card.\"\n//   4. Bundle pricing: \"Buy plan + topup, save $2\"\n//   5. Gift purchases: \"Buy credits for friend\"\n//

import { Request, Response } from 'express';
import { createPlanCheckout, createTopUpCheckout } from './providers/dodo.provider';
import { PLAN_CONFIG, TOPUP_PACKS } from '../../config/constants';
import { InitCheckoutRequest, TopUpCheckoutRequest } from './payment.types';
import { BadRequestError, ConflictError, ForbiddenError, AppError, BadGatewayError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

// ── POST /api/checkout/init ───────────────────────────────────────────────────

export async function initCheckoutHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { planId } = req.body as InitCheckoutRequest;
  const { plan: currentPlan, isActive, topup_credits, days_left, subscription_cancelled } = req.planState;

  if (!planId || planId !== 'pro') {
    throw new BadRequestError('planId must be "pro"', 'invalid_plan');
  }

  // BUG-C-01 fix: If the user cancelled auto-renewal, allow them to re-subscribe
  if (isActive && currentPlan === planId && !subscription_cancelled) {
    throw new ConflictError('You are already on the Pro plan with active auto-renewal.', 'already_on_plan');
  }

  if (!PLAN_CONFIG[planId].priceId) {
    logger.error(`[payment.controller] Dodo price ID not configured for plan: ${planId}`);
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  if (!process.env.DODO_API_KEY) {
    logger.error('[payment.controller] DODO_API_KEY is not set in environment');
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  try {
    const { checkoutUrl, checkoutId } = await createPlanCheckout(
      req.figmaUserId,
      planId,
      topup_credits,
      days_left
    );

    sendSuccess(res, { checkoutUrl, checkoutId });
  } catch (err) {
    logger.error('[payment.controller] createPlanCheckout error:', err);
    throw new BadGatewayError('Failed to create checkout session. Please try again.', 'checkout_failed');
  }
}

// ── POST /api/checkout/topup ──────────────────────────────────────────────────

export async function topupCheckoutHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { packId } = req.body as TopUpCheckoutRequest;
  const { isActive } = req.planState;

  if (!isActive) {
    throw new ForbiddenError(
      'An active Pro plan is required to purchase credit top-ups.',
      'plan_required'
    );
  }

  if (!packId || !['small', 'medium', 'large'].includes(packId)) {
    throw new BadRequestError('packId must be "small", "medium", or "large"', 'invalid_pack');
  }

  if (!TOPUP_PACKS[packId].priceId) {
    logger.error(`[payment.controller] Dodo price ID not configured for pack: ${packId}`);
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  try {
    const { checkoutUrl, checkoutId } = await createTopUpCheckout(
      req.figmaUserId,
      packId
    );

    sendSuccess(res, {
      checkoutUrl,
      checkoutId,
      pack_info: {
        credits: TOPUP_PACKS[packId].credits,
        price:   TOPUP_PACKS[packId].priceLabel,
      },
    });
  } catch (err) {
    logger.error('[payment.controller] createTopUpCheckout error:', err);
    throw new BadGatewayError('Failed to create checkout session. Please try again.', 'checkout_failed');
  }
}
