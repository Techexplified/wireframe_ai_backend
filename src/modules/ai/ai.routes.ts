// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/ai/ai.routes.ts — Feature / AI Generation Routes
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// ROUTE MAP (mounted at /api/features):
//   POST /generate/start  — initiate wireframe generation (stream response)
//   POST /generate/check  — pre-flight check (informational, no charge)
//   POST /generate/refund — refund a failed generation attempt
//
// KEY CONCEPTS:
//   
//   \"generation\": entire flow from user request to final HTML output
//     • Requires prompt, device, style parameters
//     • Returns Server-Sent Events stream with generation progress
//     • Deducts credits atomically (reservation → settle)
//     • Can fail mid-stream → automatic refund on client disconnect
//   
//   \"check\": verify user can generate (pre-flight validation)
//     • Runs same guards as /start (rate limit, quota, budget)
//     • Does NOT deduct credits (informational only)
//     • Lets client know if generation will succeed before attempting
//   
//   \"refund\": return credits for failed generation
//     • Used if generation failed after credit deduction
//     • Client provides reservationId (from X-Reservation-Id header)
//     • Server looks up reservation, refunds amount
//
// MIDDLEWARE STACKS (order enforces guardrails):
//   
//   POST /generate/start (Trigger B — Full Protection):
//     1. authMiddleware — verify identity, load planState
//     2. aiRateLimitMiddleware — enforce 3/10s (pro) or 1/30s (free)
//     3. aiQuotaMiddleware — enforce daily token limits (500k pro, 50k free)
//     4. aiBudgetMiddleware — enforce per-request cost cap ($0.80 pro, $0.10 free)
//     5. startGenerationHandler — process generation
//     
//   Why this stack?
//     • Rate limit first: cheap check, blocks abuse early
//     • Quota: medium-cost check, prevents token burn
//     • Budget: most expensive (complexity scoring), but must pass to avoid overages
//     • Handler last: only runs if all guards pass
//   
//   POST /generate/check (Fix H-06 — Same Stack):
//     1-4. Same middleware as /start
//     5. checkGenerationHandler — return {can_generate: true/false, reason: '...'}
//     
//   Why same stack?
//     • Fix H-06: ensures check and start use identical logic
//     • If check passes, start will also pass same guards
//     • Prevents: \"check said OK but start failed\" (confusion)
//     • Also ensures: /check respects rate limits (no spam via /check)
//     
//   POST /generate/refund:
//     1. authMiddleware only
//     2. refundGenerationHandler
//     
//   Why no other middleware?
//     • Refund is recovery operation, not a generation
//     • Should not count against rate limits
//     • Should not consume quota
//     • Should not consume budget
//     • Refund amount determined by reservationId (server-side lookup)
//
// HANDLER RESPONSIBILITIES:
//   
//   startGenerationHandler (ai.controller.ts):
//     • Reserve credits atomically (prevents double-charging)
//     • Call OpenRouter API with streaming
//     • Attach telemetry middleware to stream (token counting)
//     • Send SSE headers (Content-Type: text/event-stream)
//     • On stream completion: settle reservation (mark complete)
//     • On stream error: refund reservation (return credits)
//     • On client disconnect: abort OpenRouter call + refund
//     → Returns: streaming HTTP 200 with SSE payload
//   
//   checkGenerationHandler (credit.controller.ts):
//     • Same middleware pre-validation as /start
//     • Does NOT deduct credits (informational only)
//     • Returns: { can_generate: true, message: \"...\", credits_left: 95 }
//     → Returns: HTTP 200 with JSON payload
//   
//   refundGenerationHandler (credit.controller.ts):
//     • Lookup reservationId in credit_reservations collection
//     • Refund amount stored with reservation (server-side)
//     • Add credits back to user's balance
//     • Returns: { success: true, credits_restored: 5, credits_left: 100 }
//     → Returns: HTTP 200 with JSON payload
//
// REQUEST/RESPONSE EXAMPLES:
//   
//   POST /api/features/generate/start
//   Request:
//     {
//       prompt: \"3-column dashboard with sidebar\",
//       device: \"desktop\",
//       style: \"modern\",
//       model: \"gpt-5.6-luna\",
//       fidelity: \"high\"
//     }
//   
//   Response (streaming):
//     HTTP 200 OK
//     X-Reservation-Id: abc-123  (client saves for refund if needed)
//     X-Credits-Deducted: 5
//     X-Credits-Left: 95
//     Content-Type: text/event-stream
//     
//     data: {\"type\":\"generation_start\",\"model\":\"gpt-5.6-luna\"}
//     data: {\"type\":\"token\",\"content\":\"<html>...\"}
//     data: {\"type\":\"token\",\"content\":\"...\"}
//     data: {\"type\":\"complete\",\"tokens\":1234}
//   
//   POST /api/features/generate/check
//   Request:
//     {
//       prompt: \"3-column dashboard with sidebar\",
//       device: \"desktop\",
//       style: \"modern\"
//     }
//   
//   Response (200 OK):
//     {
//       can_generate: true,
//       reason: \"You have enough credits and rate limit available\",
//       credits_left: 95,
//       topup_credits_left: 10
//     }
//   
//   POST /api/features/generate/refund
//   Request:
//     {
//       reservationId: \"abc-123\"
//     }
//   
//   Response (200 OK):
//     {
//       success: true,
//       credits_restored: 5,
//       credits_left: 100,
//       topup_credits_left: 10
//     }
//
// FIXES APPLIED:
//   Fix H-06: /check now uses full middleware stack
//     • Before: only auth + basic checks
//     • After: same stack as /start (rate limit + quota + budget)
//     • Result: /check accurately predicts /start outcome
//   
//   Fix H-02: /check is informational, no credit deduction
//     • Before: might have deducted credits for pre-check
//     • After: only deducts on /start completion
//     • Result: user can check balance repeatedly without cost
//
// ERROR RESPONSES:
//   
//   Rate limit exceeded (429):
//     { error: \"rate_limit_exceeded\", message: \"Please wait X seconds...\" }
//   
//   Daily quota exceeded (429):
//     { error: \"daily_quota_exceeded\", message: \"Quota reset at midnight UTC\" }
//   
//   Budget exceeded (402):
//     { error: \"budget_exceeded\", message: \"Request too expensive for your plan\" }
//   
//   Insufficient credits (403):
//     { error: \"insufficient_credits\", message: \"Not enough credits...\" }
//   
//   OpenRouter error (502):
//     { error: \"ai_error\", message: \"Generation failed...\" }
//     (Credits automatically refunded on mid-stream error)
//
// STREAMING PROTOCOL:
//   Response type: Server-Sent Events (SSE)
//   
//   Standard SSE format:
//     data: <json payload>
//     
//   Token data:
//     {\"type\":\"token\",\"content\":\"<html part>\"}
//   
//   Final data:
//     {\"type\":\"complete\",\"tokens\":1234,\"cost_usd\":0.05}
//   
//   Client implementation:
//     const eventSource = new EventSource('/api/features/generate/start');
//     eventSource.onmessage = (msg) => {
//       const data = JSON.parse(msg.data);
//       if (data.type === 'token') display(data.content);
//       if (data.type === 'complete') celebrate();
//     };

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { startGenerationHandler } from './ai.controller';
import { checkGenerationHandler, refundGenerationHandler } from '../credits/credit.controller';
import { aiRateLimitMiddleware } from './middleware/ai.rate-limit.middleware';
import { aiQuotaMiddleware } from './middleware/ai.quota.middleware';
import { aiBudgetMiddleware } from './middleware/ai.budget.middleware';
import { ipRateLimitMiddleware } from '../../middleware/ip.rate-limit.middleware';

const router = Router();

// ── POST /generate/start ──────────────────────────────────────────────────────
// Full protection middleware stack (auth + IP limit + per-user rate limit + quota + cost cap)

router.post(
  '/generate/start',
  authMiddleware,
  ipRateLimitMiddleware,
  aiRateLimitMiddleware,
  aiQuotaMiddleware,
  aiBudgetMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    startGenerationHandler(req, res).catch(next);
  }
);

// ── POST /generate/check ──────────────────────────────────────────────────────
// Fix H-06: Now uses the same full middleware stack as /start.
// Guarantees: if /check passes, /start will also pass the same guards.
// Handler is informational only — NO credit deduction (Fix H-02).

router.post(
  '/generate/check',
  authMiddleware,
  ipRateLimitMiddleware,
  aiRateLimitMiddleware,
  aiQuotaMiddleware,
  aiBudgetMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkGenerationHandler(req, res).catch(next);
  }
);

// ── POST /generate/refund ─────────────────────────────────────────────────────
// No rate limit — this is a recovery operation, not an AI call

router.post(
  '/generate/refund',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    refundGenerationHandler(req, res).catch(next);
  }
);

export default router;
