export interface SubscriptionStatusResponse {
  plan: string;
  isActive: boolean;
  credits: number;
  topup_credits: number;
  total_credits: number;
  days_left: number;
  subscription_ends_at: string | null;
  subscription_cancelled: boolean;
  show_upgrade: boolean;
  show_topup: boolean;
  show_renew: boolean;
  is_trial: boolean;
  last_payment_attempt?: {
    payment_id?: string;
    status: 'failed' | 'succeeded';
    error_code?: string;
    error_message?: string;
    failed_at?: string;
  } | null;
}
