// ─── modules/subscriptions/subscription.types.ts — Subscription response types ─

export interface SubscriptionStatusResponse {
  plan: string;
  isActive: boolean;
  credits: number;
  topup_credits: number;
  total_credits: number;
  days_left: number;
  subscription_ends_at: string | null;
  show_upgrade: boolean;
  show_topup: boolean;
  show_renew: boolean;
  is_trial: boolean;
}
