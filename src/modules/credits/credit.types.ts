// ─── modules/credits/credit.types.ts — Credit domain types ───────────────────

export interface CreditReservationResult {
  success:           boolean;
  creditsLeft:       number;
  topup_creditsLeft: number;
  pool:              'plan' | 'topup';
  reservationId:     string;   // Fix CREDIT-C-01: UUID used to authorize refund
}

// Fix CREDIT-C-01: Refund no longer accepts client-supplied cost/pool.
// Only reservationId is accepted — server looks up the authoritative amount.
export interface RefundRequest {
  reservationId: string;
}
