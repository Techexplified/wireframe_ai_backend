// ─── middleware/startup.validation.ts — Required env var guard ────────────────
//
// Called once at module load. Fails loudly if any required env var is missing
// so misconfigurations are caught at deploy time, not at runtime.
// Fix FIREBASE-M-01 / SEC-C-01 mitigation.

const REQUIRED_VARS = [
  'MONGODB_URI',
  'OPENROUTER_API_KEY',
  'DODO_WEBHOOK_SECRET',   // must be set — missing = all webhooks rejected (fail-closed)
  'DODO_API_KEY',          // must be set — missing = all checkout calls fail
];

const WARN_ONLY_VARS = [
  'DODO_PRODUCT_PRO',
  'DODO_PRODUCT_TOPUP_SMALL',
  'DODO_PRODUCT_TOPUP_MEDIUM',
  'DODO_PRODUCT_TOPUP_LARGE',
];

export function validateStartupEnv(): void {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  const empty   = WARN_ONLY_VARS.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    const msg = `[startup] FATAL: Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
      'Set these in Firebase Secrets Manager or your .env file before deploying.';
    console.error(msg);
    // In production this prevents the function from accepting requests silently
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (empty.length > 0) {
    console.warn(
      `[startup] WARNING: Dodo product IDs not configured:\n  ${empty.join('\n  ')}\n` +
      'Checkout endpoints will return 500 until these are set.'
    );
  }

  console.log('[startup] Environment validation passed ✓');
}
