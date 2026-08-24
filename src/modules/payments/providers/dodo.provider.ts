// ─── modules/payments/providers/dodo.provider.ts — Dodo Payments integration ──
//
// Wraps Dodo API calls: createCheckout for plan purchases and top-ups.
// Also provides webhook signature verification [⑤].
//
// Dodo Payments docs: https://docs.dodopayments.com

import axios from 'axios';
import * as crypto from 'crypto';
import { PlanId, TopUpPackId, PLAN_CONFIG, TOPUP_PACKS } from '../../../config/constants';

const DODO_API_KEY     = process.env.DODO_API_KEY     || '';
const DODO_ENV         = process.env.DODO_ENV         || 'test';
const DODO_BASE_URL    = DODO_ENV === 'live'
  ? 'https://live.dodopayments.com'
  : 'https://test.dodopayments.com';
const APP_BASE_URL     = process.env.APP_BASE_URL     || '';

const dodoClient = axios.create({
  baseURL: DODO_BASE_URL,
  headers: {
    Authorization:  `Bearer ${DODO_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
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
    return_url: `${APP_BASE_URL}/checkout/success`,
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
    return_url: `${APP_BASE_URL}/checkout/success`,
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
