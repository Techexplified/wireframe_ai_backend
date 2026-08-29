// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── middleware/startup.validation.ts — Startup Environment Validation
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Validates required environment variables at module load (before any requests).
//   Fails fast with clear error if critical config is missing.
//   Prevents silent runtime failures (endpoints returning 500 due to missing config).
//
// WHEN IT RUNS:
//   • Called in index.ts BEFORE Firebase Functions initialization
//   • If validation fails: throws error, function initialization stops
//   • Firebase Logs display error: deployment detects misconfiguration
//   • Function does not accept requests until redeployed correctly
//
// REQUIRED VARIABLES (Deployment Fails if Missing):
//   • MONGODB_URI — MongoDB connection string
//     → Fallback: none (all queries fail without it)
//     → Impact: 500 errors on every request
//   
//   • OPENROUTER_API_KEY — AI inference provider API key
//     → Fallback: none (generation fails without it)
//     → Impact: 502 Bad Gateway on /api/features/generate/start
//   
//   • DODO_WEBHOOK_SECRET — webhook signature verification secret (Fix SEC-C-01)
//     → Fallback: none (webhooks must be signed)
//     → Impact: 403 Forbidden on all webhooks (fail-closed by design)
//     → Security: prevents unverified payment confirmations
//   
//   • DODO_API_KEY — payment provider API key
//     → Fallback: none (checkout calls fail without it)
//     → Impact: 500 errors on /api/checkout/init and /topup
//
// OPTIONAL VARIABLES (Warnings Only, Features Degrade):
//   • DODO_PRODUCT_PRO — Dodo product ID for Pro plan
//   • DODO_PRODUCT_TOPUP_SMALL/MEDIUM/LARGE — product IDs for credit packs
//     → Fallback: undefined
//     → Impact: 500 errors on checkout calls (missing priceId)
//     → Design: safer to fail than charge wrong product
//     → Typical scenario: not yet configured on first deploy
//
// FIXING FIREBASE-M-01:
//   Firebase Functions cold starts can be slow (~30s)
//   
//   WITHOUT this validation:
//     • First user request hits missing env var
//     • Function waits 30s for cold start
//     • User gets 500 error after 30s wait
//     • Developer unaware (error may not appear in logs)
//   
//   WITH this validation:
//     • Deployment immediately fails with clear error
//     • Cloud Functions console shows: "FATAL: Missing required environment variables"
//     • Developer configures, redeploys, problem solved
//     • No user-facing errors due to misconfiguration
//
// FIXING SEC-C-01:
//   DODO_WEBHOOK_SECRET must be set before deploying
//   
//   If missing:
//     • Webhook signature verification would be skipped
//     • Attackers could forge payment confirmations
//     • Users would receive credits without paying
//   
//   This validation prevents that scenario
//     • Missing secret → deployment fails
//     • Only way to proceed: configure secret
//
// ERROR MESSAGES:
//   Thrown error stops function initialization
//   Error message:
//     "[startup] FATAL: Missing required environment variables: [...]"
//   User impact: function completely unavailable until fixed
//   Developer impact: clear signal to configure before deploying

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
