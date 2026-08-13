// ─── modules/credits/credit.types.ts — Credit domain types ───────────────────

export interface CreditReservationResult {
  success: boolean;
  creditsLeft: number;
  topup_creditsLeft: number;
  pool: 'plan' | 'topup'; // which pool was actually deducted — used for refund routing
}

export interface RefundRequest {
  pool?: 'plan' | 'topup';
  cost?: number; // credits to refund — must match the amount originally deducted
}
