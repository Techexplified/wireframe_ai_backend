// ─── modules/users/user.types.ts — User & Plan domain types ──────────────────
//
// PlanState: the computed business view of a user's subscription status.
// UserDoc is the raw MongoDB document (lives in config/database.ts to avoid
// circular imports); re-exported here for convenience.

import { PlanId } from '../../config/constants';
import { PaymentAttemptInfo } from '../../config/user.model';
export type { UserDoc } from '../../config/database';

export interface PlanState {
  plan: PlanId;
  isActive: boolean;
  credits: number;
  topup_credits: number;
  days_left: number;
  subscription_ends_at: Date | null;
  subscription_cancelled?: boolean;
  dodo_subscription_id?: string | null;
  last_payment_attempt?: PaymentAttemptInfo | null;
}
