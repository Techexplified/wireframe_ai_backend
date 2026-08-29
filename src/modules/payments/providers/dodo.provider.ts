// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/payments/providers/dodo.provider.ts — Dodo Payments API Integration
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   Wraps Dodo Payments API for checkout creation, subscription management, and webhook verification\n//   Responsible for: delegating payment processing to Dodo (external provider)\n//   NOT responsible for: database updates (done by webhook.controller)\n//\n// WHY DODO PAYMENTS?\n//   \n//   Alternatives considered:\n//     • Stripe: strong, but designed for US/EU (not global)\n//     • Square: good regional coverage, but payment fees higher\n//     • Adyen: global reach, but complex integration\n//   \n//   Dodo chosen for:\n//     • Global coverage (supported in 180+ countries)\n//     • Subscription support (auto-billing, renewal)\n//     • Low payment fees (2.5% + $0.30)\n//     • Simpler integration (webhook verification straightforward)\n//     • Test/Live environment support (DODO_ENV=test|live)\n//\n// API ENVIRONMENT CONFIGURATION:\n//   \n//   Test environment:\n//     • DODO_ENV=test or undefined (default)\n//     • Base URL: https://test.dodopayments.com\n//     • API Key: DODO_API_KEY (test key from Dodo dashboard)\n//     • Webhook Secret: DODO_WEBHOOK_SECRET (test secret)\n//     • Cards to use: 4242 4242 4242 4242 (test success)\n//     • Used for: development, staging, manual testing\n//   \n//   Live environment:\n//     • DODO_ENV=live\n//     • Base URL: https://live.dodopayments.com\n//     • API Key: DODO_API_KEY (live key from Dodo dashboard)\n//     • Webhook Secret: DODO_WEBHOOK_SECRET (live secret)\n//     • Cards: real user credit cards\n//     • Used for: production (real payments)\n//   \n//   Configuration in Firebase Cloud Functions:\n//     • Set environment variables in firebase.json or via Firebase CLI\n//     • gcloud functions deploy --set-env-vars DODO_ENV=live,DODO_API_KEY=key_...\n//     • Secrets stored in Secrets Manager (not in code)\n//\n// DODO API STRUCTURE:\n//   \n//   Product IDs (Dodo dashboard configuration):\n//     • Each plan / top-up pack has a productId in Dodo\n//     • Example: PLAN_CONFIG.pro.priceId = 'prod_pro_monthly_19_99'\n//     • Example: TOPUP_PACKS['500'].priceId = 'prod_topup_500_9_99'\n//     • Store productIds in constants.ts (NOT in code, in env or constants)\n//   \n//   Checkout Flow:\n//     1. Server calls: POST /checkouts with product_cart + metadata\n//     2. Dodo creates: temporary checkout session\n//     3. Returns: { checkout_url, session_id }\n//     4. Client redirects: browser to checkout_url\n//     5. User enters card: on Dodo's hosted checkout page (PCI-DSS compliant)\n//     6. Dodo processes: payment authorization\n//     7. Dodo redirects: back to success_url (configured in Dodo dashboard)\n//     8. Dodo calls: POST /webhooks/dodo with payment/subscription event\n//   \n//   Subscription Management:\n//     • After subscription.update webhook: Dodo stores subscription_id\n//     • Server stores: user.dodo_subscription_id\n//     • To cancel: PATCH /subscriptions/{subscriptionId} { cancel_at_next_billing_date: true }\n//     • To reactivate: PATCH /subscriptions/{subscriptionId} { cancel_at_next_billing_date: false }\n//     • Cancel takes effect: at end of current billing period (user gets full access until then)\n//\n// CHECKOUT CREATION (Two types):\n//   \n//   Type 1: Plan Upgrade (Trigger C)\n//     • User clicks \"Upgrade to Pro\" in plugin\n//     • POST /api/checkout/init called\n//     • payment.controller calls: createPlanCheckout(figmaUserId, 'pro')\n//     • This function:\n//       1. Looks up: PLAN_CONFIG['pro'].priceId\n//       2. Calls: Dodo POST /checkouts\n//       3. Stores metadata:\n//          { figmaUserId, planId: 'pro', paymentType: 'subscription',\n//            existing_topup_credits: 50, existing_days_left: 0 }\n//       4. Returns: { checkoutUrl, checkoutId }\n//     • Client receives checkoutUrl, redirects browser\n//     • User pays on Dodo checkout\n//     • Dodo sends webhook: { event_type: 'subscription.update', subscription_id: '...', ... }\n//     • webhook.controller processes: updates user.plan, user.dodo_subscription_id\n//   \n//   Type 2: Top-up Credits (Trigger D)\n//     • User clicks \"Buy More Credits\" in plugin\n//     • Selects package: 100/500/1000 credits\n//     • POST /api/checkout/topup { packId: '500' } called\n//     • payment.controller calls: createTopUpCheckout(figmaUserId, '500')\n//     • This function:\n//       1. Looks up: TOPUP_PACKS['500'].priceId\n//       2. Calls: Dodo POST /checkouts\n//       3. Stores metadata:\n//          { figmaUserId, packId: '500', paymentType: 'topup' }\n//       4. Returns: { checkoutUrl, checkoutId }\n//     • Client receives checkoutUrl, redirects browser\n//     • User pays on Dodo checkout (uses saved card if available)\n//     • Dodo sends webhook: { event_type: 'payment.complete', credits: 500, ... }\n//     • webhook.controller processes: updates user.topup_credits\n//   \n//   Metadata Fields:\n//     • figmaUserId (required): Used by webhook to identify user\n//     • planId / packId: Indicates which product was purchased\n//     • paymentType: 'subscription' or 'topup' (webhook uses this)\n//     • existing_topup_credits: snapshot of user's topup balance before purchase\n//     • existing_days_left: snapshot of user's subscription days before upgrade\n//     • Purpose: webhook has full context (doesn't need to query DB again)\n//\n// SUBSCRIPTION CANCELLATION (Trigger B - partial):\n//   \n//   User clicks \"Cancel Plan\" in plugin\n//   POST /api/subscription/cancel called\n//   subscription.controller calls: dodoProvider.cancelSubscription(user.dodo_subscription_id)\n//   This function:\n//     1. Calls: Dodo PATCH /subscriptions/{subscriptionId}\n//     2. Sets: cancel_at_next_billing_date = true\n//     3. Reason: 'cancelled_by_customer'\n//     4. Returns: updated subscription object\n//   \n//   Result:\n//     • Dodo marks subscription as \"cancel scheduled\"\n//     • At end of billing period: Dodo stops charging\n//     • Dodo sends: subscription.cancel webhook\n//     • webhook.controller updates: user.subscription_cancelled = true\n//     • User keeps pro access until subscription_ends_at (end of period)\n//     • After subscription_ends_at: daily cleanup job downgrades to free\n//   \n//   Why not cancel immediately?\n//     • Dodo & industry standard: user keeps access through end of period\n//     • User feels: \"I paid for this month, should get the month\"\n//     • Prevents: refund disputes (\"I canceled, why can't I use it?\")\n//\n// SUBSCRIPTION REACTIVATION (Trigger B - partial):\n//   \n//   User canceled on Feb 1, still pro until Feb 15\n//   User clicks \"Reactivate Plan\" before Feb 15\n//   POST /api/subscription/reactivate called\n//   subscription.controller calls: dodoProvider.reactivateSubscription(user.dodo_subscription_id)\n//   This function:\n//     1. Calls: Dodo PATCH /subscriptions/{subscriptionId}\n//     2. Sets: cancel_at_next_billing_date = false\n//     3. Returns: updated subscription object\n//   \n//   Result:\n//     • Dodo removes \"cancel scheduled\" flag\n//     • At Feb 15 (end of period): Dodo auto-renews (instead of canceling)\n//     • Dodo sends: subscription.update webhook (with new subscription_ends_at)\n//     • webhook.controller updates: user.subscription_cancelled = false\n//     • Subscription continues indefinitely (until user cancels again)\n//\n// WEBHOOK SIGNATURE VERIFICATION (SEC-C-01):\n//   \n//   Problem: Webhooks are HTTP POST from Dodo to our server\n//     • Anyone could POST to /webhooks/dodo\n//     • Could fake payment.complete event (\"User paid! Give credits!\")\n//     • Could steal other users' credits\n//   \n//   Solution: HMAC signature verification\n//     • Dodo sends: Authorization header with HMAC-SHA256 signature\n//     • Signature computed: HMAC-SHA256(request_body, DODO_WEBHOOK_SECRET)\n//     • Server verifies: compute same HMAC, compare with header\n//     • Only passes if: signatures match (webhook really came from Dodo)\n//   \n//   Signature Formats (we support both):\n//     \n//     Format A: Svix standard (Dodo's preference)\n//       • Headers:\n//         - webhook-id: msg_abc123\n//         - webhook-timestamp: 1787149876 (Unix timestamp)\n//         - webhook-signature: v1,base64_sig1 v1,base64_sig2 ...\n//       • Signature computation: HMAC-SHA256('msg_abc123.1787149876.{raw_body}', secret)\n//       • Multiple signatures: for key rotation (server supports old+new key)\n//     \n//     Format B: Legacy Dodo format\n//       • Header: Authorization-Signature: t=1787149876,v1=hex_sig\n//       • Signature computation: HMAC-SHA256('1787149876.{raw_body}', secret)\n//       • Fallback: if Format A not detected, try Format B\n//   \n//   Replay Attack Prevention:\n//     • Webhook timestamp checked: must be within 300 seconds (5 minutes)\n//     • If older: reject (\"this webhook is from 10 minutes ago, probably replayed\")\n//     • Why 300s? Allows for clock skew between Dodo and our servers\n//   \n//   Implementation Flow (verifyWebhookSignature):\n//     1. Check: DODO_WEBHOOK_SECRET env var exists (fail-closed)\n//     2. Check: signatureHeader provided (fail-closed)\n//     3. Determine: Svix format (v1,) or legacy format (t=)\n//     4. Extract: timestamp (replay check)\n//     5. Compute: expected HMAC-SHA256 signature\n//     6. Compare: timingSafeEqual (constant-time, prevents timing attacks)\n//     7. Return: true if match, false otherwise\n//   \n//   Used by: webhook.routes.ts before processing event\n//     • If verification fails: return 403 Forbidden\n//     • If verification succeeds: process event (update DB, return 200)\n//\n// TIMING ATTACK PREVENTION (crypto.timingSafeEqual):\n//   \n//   Simple comparison: sig1 === sig2\n//     • If sig1[0] !== sig2[0]: returns false immediately (0 ms)\n//     • If match on [0] but fail on [1]: returns false (1ms more)\n//     • Attacker times comparison: \"Failed at byte 5? Let me adjust byte 5...\"\n//     • Result: attacker can forge signatures byte-by-byte (very slow, but possible)\n//   \n//   Timing-safe comparison: crypto.timingSafeEqual\n//     • Always compares all bytes (even if early mismatch)\n//     • Always takes ~same time (whether sig matches or not)\n//     • Attacker can't use timing to guess bytes\n//     • Result: safer against timing attacks\n//   \n//   Why bother? These attacks are exotic (require precise timing on network)\n//   But security best practice: use timingSafeEqual for HMACs\n//\n// AXIOSClient Configuration:\n//   \n//   baseURL: DODO_BASE_URL (test or live)\n//   headers:\n//     • Authorization: Bearer {DODO_API_KEY}\n//     • Content-Type: application/json\n//   timeout: 25000 ms (25 seconds)\n//   \n//   Why 25s? (vs. Firebase Cloud Functions default 5 min)\n//     • Dodo API usually responds in <5 seconds\n//     • 25s allows for network latency, processing delays\n//     • If Dodo slower than 25s: timeout, error returned, client sees 502\n//   \n//   Error Handling:\n//     • If Dodo down: axios throws AxiosError\n//     • Caught by: payment.controller try-catch\n//     • Returned to client: 502 Bad Gateway (\"Checkout service unavailable\")\n//     • Credits: not reserved (error before reservation)\n//\n// PRODUCT IDMISMATCH (critical bug):\n//   \n//   If PLAN_CONFIG.pro.priceId not configured:\n//     • createPlanCheckout throws: \"Dodo product ID not configured\"\n//     • Firebase Cloud Functions error log shows exception\n//     • Client sees: 500 Internal Server Error\n//     • Credits: not reserved (error before reservation)\n//   \n//   Prevention:\n//     • constants.ts must list all priceIds (from Dodo dashboard)\n//     • startup.validation.ts should verify priceIds are set (if not, fail-closed)\n//     • Test environment: verify priceIds point to test products\n//     • Live environment: verify priceIds point to live products\n//\n// CIRCUIT BREAKER (not implemented, but recommended):\n//   \n//   If Dodo API is experiencing issues:\n//     • We could implement: circuit breaker pattern\n//     • After N consecutive failures: stop calling Dodo\n//     • Return: 503 Service Unavailable (instead of 502)\n//     • Allow time: for Dodo to recover\n//     • Retry: after exponential backoff\n//   \n//   Currently: each call independent (no circuit breaker)\n//   If Dodo down: every checkout attempt fails\n//   Better: after 5 failures, disable checkouts temporarily (return 503)\n//\n// TESTING:\n//   \n//   Test environment setup:\n//     • firebase.json: set DODO_ENV=test\n//     • constants.ts: point to test product IDs (from Dodo dashboard)\n//     • Test card: 4242 4242 4242 4242 (always succeeds)\n//     • Verify: checkouts work, webhooks signed correctly\n//   \n//   Production setup:\n//     • firebase.json: set DODO_ENV=live\n//     • constants.ts: point to live product IDs (from Dodo dashboard)\n//     • Real cards: users enter their real credit cards\n//     • Monitor: Dodo dashboard for payment activity\n//

import axios from 'axios';
import * as crypto from 'crypto';
import { PlanId, TopUpPackId, PLAN_CONFIG, TOPUP_PACKS } from '../../../config/constants';

const DODO_API_KEY     = process.env.DODO_API_KEY     || '';
const DODO_ENV         = process.env.DODO_ENV         || 'test';
const DODO_BASE_URL    = DODO_ENV === 'live'
  ? 'https://live.dodopayments.com'
  : 'https://test.dodopayments.com';

const dodoClient = axios.create({
  baseURL: DODO_BASE_URL,
  headers: {
    Authorization:  `Bearer ${DODO_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 25000,
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckoutResult {
  checkoutUrl: string;
  checkoutId: string;
}

// ─── createPlanCheckout — Trigger C ──────────────────────────────────────────
//
// Creates a checkout session for a plan via Dodo Payments.
// Stores figmaUserId + planId + snapshot data in metadata for webhook processing.

export async function createPlanCheckout(
  figmaUserId: string,
  planId: PlanId,
  existingTopupCredits: number,
  existingDaysLeft: number
): Promise<CheckoutResult> {
  const config = PLAN_CONFIG[planId];

  if (!config.priceId) {
    throw new Error(`Dodo product ID not configured for plan: ${planId}`);
  }

  const response = await dodoClient.post('/checkouts', {
    product_cart: [
      {
        product_id: config.priceId,
        quantity:   1,
      },
    ],
    metadata: {
      figmaUserId,
      planId,
      paymentType:            'subscription',  // canonical field (webhook reads this)
      existing_topup_credits: String(existingTopupCredits),
      existing_days_left:     String(existingDaysLeft),
    },
  });

  return {
    checkoutUrl: response.data.checkout_url || response.data.url,
    checkoutId:  response.data.session_id  || response.data.id || '',
  };
}

// ─── createTopUpCheckout — Trigger D ─────────────────────────────────────────
//
// Creates a checkout session for a credit top-up pack.

export async function createTopUpCheckout(
  figmaUserId: string,
  packId: TopUpPackId
): Promise<CheckoutResult> {
  const pack = TOPUP_PACKS[packId];

  if (!pack.priceId) {
    throw new Error(`Dodo product ID not configured for top-up pack: ${packId}`);
  }

  const response = await dodoClient.post('/checkouts', {
    product_cart: [
      {
        product_id: pack.priceId,
        quantity:   1,
      },
    ],
    metadata: {
      figmaUserId,
      packId,
      paymentType: 'topup',  // canonical field (webhook reads this)
    },
  });

  return {
    checkoutUrl: response.data.checkout_url || response.data.url,
    checkoutId:  response.data.session_id  || response.data.id || '',
  };
}

// ─── cancelSubscription ──────────────────────────────────────────────────────
//
// Schedules cancellation at the end of the current billing period via Dodo API.
// Subscription stays active until next billing date.

export async function cancelSubscription(subscriptionId: string): Promise<unknown> {
  const response = await dodoClient.patch(`/subscriptions/${subscriptionId}`, {
    cancel_at_next_billing_date: true,
    cancel_reason: 'cancelled_by_customer',
  });
  return response.data;
}

// ─── reactivateSubscription ──────────────────────────────────────────────────
//
// Un-cancels a subscription that was scheduled to cancel at next billing date.
// Restores auto-renewal for the next cycle.

export async function reactivateSubscription(subscriptionId: string): Promise<unknown> {
  const response = await dodoClient.patch(`/subscriptions/${subscriptionId}`, {
    cancel_at_next_billing_date: false,
  });
  return response.data;
}

export interface WebhookSignatureMeta {
  msgId?: string;
  timestamp?: string;
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  meta?: WebhookSignatureMeta
): boolean {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      '[dodo.provider] DODO_WEBHOOK_SECRET is not set. All webhook requests will be rejected.'
    );
    return false;
  }

  if (!signatureHeader) return false;

  const rawBodyStr = rawBody.toString('utf8');

  // Case A: Standard Webhook (Svix format used by Dodo Payments)
  // Headers:
  //   webhook-id: msg_...
  //   webhook-timestamp: 1787149876
  //   webhook-signature: v1,Base64...
  if (signatureHeader.startsWith('v1,') || meta?.msgId) {
    const timestamp = meta?.timestamp;
    const msgId = meta?.msgId;

    if (timestamp) {
      const REPLAY_WINDOW_SECONDS = 300;
      const webhookTime = parseInt(timestamp, 10);
      const nowSeconds  = Math.floor(Date.now() / 1000);
      if (!isNaN(webhookTime) && Math.abs(nowSeconds - webhookTime) > REPLAY_WINDOW_SECONDS) {
        console.warn(
          `[dodo.provider] Webhook timestamp rejected — age: ${nowSeconds - webhookTime}s (max: ${REPLAY_WINDOW_SECONDS}s)`
        );
        return false;
      }
    }

    const secretBytes = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice(6), 'base64')
      : Buffer.from(secret, 'utf8');

    const signatures = signatureHeader
      .split(' ')
      .filter((s) => s.startsWith('v1,'))
      .map((s) => s.slice(3));

    if (msgId && timestamp) {
      const toSign = `${msgId}.${timestamp}.${rawBodyStr}`;
      const expectedSig = crypto
        .createHmac('sha256', secretBytes)
        .update(toSign)
        .digest('base64');

      for (const sig of signatures) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expectedSig, 'base64'))) {
            return true;
          }
        } catch {}
      }
    }
  }

  // Case B: Legacy / direct Dodo-Signature header: "t=1234567890,v1=abc123..."
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, val] = part.split('=');
    if (key && val) acc[key.trim()] = val.trim();
    return acc;
  }, {});

  const timestamp   = parts['t'] || meta?.timestamp;
  const receivedSig = parts['v1'] || (signatureHeader.startsWith('v1,') ? signatureHeader.slice(3) : signatureHeader);

  if (!timestamp || !receivedSig) return false;

  const REPLAY_WINDOW_SECONDS = 300;
  const webhookTime = parseInt(timestamp, 10);
  const nowSeconds  = Math.floor(Date.now() / 1000);
  if (isNaN(webhookTime) || Math.abs(nowSeconds - webhookTime) > REPLAY_WINDOW_SECONDS) {
    console.warn(
      `[dodo.provider] Webhook timestamp rejected — age: ${nowSeconds - webhookTime}s (max: ${REPLAY_WINDOW_SECONDS}s)`
    );
    return false;
  }

  const signedPayload = `${timestamp}.${rawBodyStr}`;

  // Check hex
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  try {
    if (crypto.timingSafeEqual(Buffer.from(receivedSig, 'hex'), Buffer.from(expectedHex, 'hex'))) {
      return true;
    }
  } catch {}

  // Check base64
  const expectedB64 = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('base64');

  try {
    if (crypto.timingSafeEqual(Buffer.from(receivedSig, 'base64'), Buffer.from(expectedB64, 'base64'))) {
      return true;
    }
  } catch {}

  return false;
}
