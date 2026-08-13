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
const DODO_WEBHOOK_SEC = process.env.DODO_WEBHOOK_SECRET || '';
const APP_BASE_URL     = process.env.APP_BASE_URL     || '';

const dodoClient = axios.create({
  baseURL: 'https://api.dodopayments.com/v1',
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
// Creates a one-time payment checkout for a plan.
// Stores figmaUserId + planId + snapshot data in metadata for webhook processing.
// Fix ⑦: product MUST be one-time price, NOT a recurring subscription.

export async function createPlanCheckout(
  figmaUserId: string,
  planId: PlanId,
  existingTopupCredits: number,
  existingDaysLeft: number
): Promise<CheckoutResult> {
  const config = PLAN_CONFIG[planId];

  if (!config.priceId) {
    throw new Error(`Dodo price ID not configured for plan: ${planId}`);
  }

  const response = await dodoClient.post('/checkout/sessions', {
    price_id:    config.priceId,
    success_url: `${APP_BASE_URL}/checkout/success`,
    cancel_url:  `${APP_BASE_URL}/checkout/cancel`,
    metadata: {
      figmaUserId,
      planId,
      existing_topup_credits: String(existingTopupCredits),
      existing_days_left:     String(existingDaysLeft),
      payment_type:           'plan',
    },
  });

  return {
    checkoutUrl: response.data.url,
    checkoutId:  response.data.id,
  };
}

// ─── createTopUpCheckout — Trigger D ─────────────────────────────────────────
//
// Creates a one-time payment checkout for a credit top-up pack.

export async function createTopUpCheckout(
  figmaUserId: string,
  packId: TopUpPackId
): Promise<CheckoutResult> {
  const pack = TOPUP_PACKS[packId];

  if (!pack.priceId) {
    throw new Error(`Dodo price ID not configured for top-up pack: ${packId}`);
  }

  const response = await dodoClient.post('/checkout/sessions', {
    price_id:    pack.priceId,
    success_url: `${APP_BASE_URL}/checkout/success`,
    cancel_url:  `${APP_BASE_URL}/checkout/cancel`,
    metadata: {
      figmaUserId,
      packId,
      payment_type: 'topup',
    },
  });

  return {
    checkoutUrl: response.data.url,
    checkoutId:  response.data.id,
  };
}

// ─── verifyWebhookSignature — Fix ⑤ ──────────────────────────────────────────
//
// Verifies Dodo's HMAC-SHA256 webhook signature.
// MUST be called FIRST, before ANY business logic or idempotency check.
// Rejects requests with invalid signatures immediately.
//
// Dodo sends: Dodo-Signature: t=timestamp,v1=signature
// We compute: HMAC-SHA256(secret, timestamp + "." + rawBody)

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string
): boolean {
  if (!DODO_WEBHOOK_SEC) {
    console.warn('[dodo.provider] DODO_WEBHOOK_SECRET not set — skipping verification in dev');
    return process.env.NODE_ENV !== 'production';
  }

  // Parse header: "t=1234567890,v1=abc123..."
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, val] = part.split('=');
    if (key && val) acc[key.trim()] = val.trim();
    return acc;
  }, {});

  const timestamp   = parts['t'];
  const receivedSig = parts['v1'];

  if (!timestamp || !receivedSig) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expectedSig   = crypto
    .createHmac('sha256', DODO_WEBHOOK_SEC)
    .update(signedPayload)
    .digest('hex');

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expectedSig,  'hex')
    );
  } catch {
    return false;
  }
}
