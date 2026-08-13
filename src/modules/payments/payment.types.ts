// ─── modules/payments/payment.types.ts — Payment & Checkout domain types ──────

import { PlanId, TopUpPackId } from '../../config/constants';

export interface InitCheckoutRequest {
  planId?: PlanId;
}

export interface TopUpCheckoutRequest {
  packId?: TopUpPackId;
}

export interface CheckoutResponse {
  checkoutUrl: string;
  checkoutId: string;
  pack_info?: {
    credits: number;
    price: string;
  };
}
