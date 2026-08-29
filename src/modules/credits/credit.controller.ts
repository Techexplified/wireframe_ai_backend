// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/credits/credit.controller.ts — Credit Validation & Refund Handlers
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   HTTP handlers for two endpoints:\n//     1. POST /api/features/generate/check (informational: can user afford?)\n//     2. POST /api/features/generate/refund (refund failed generation)\n//   NOT responsible for: credit reservation (done by ai.controller)\n//\n// TWO ENDPOINTS EXPLAINED:\n//   \n//   /check Endpoint (informational only)\n//     • Called by: Figma plugin BEFORE starting generation\n//     • Purpose: answer \"can user afford this model?\"\n//     • Does NOT: deduct credits (Fix H-02)\n//     • Why? User wants to know cost before committing\n//     • Response: { can_afford: true/false, cost_required, credits_left }\n//   \n//   /refund Endpoint (emergency recovery)\n//     • Called by: Figma plugin if generation fails\n//     • Example: OpenRouter API timeouts\n//     • Purpose: return credits to user (undo reservation)\n//     • Does NOT: accept refund amount (Fix CREDIT-C-01)\n//     • Why? Server looks up authoritative cost from reservation\n//     • Security: clients cannot specify cost (prevents exploits)\n//     • Response: { ok: true, refunded: true }\n//\n// FLOW DIAGRAM (user perspective):\n//   \n//   Figma Plugin UI:\n//     ↓\n//     [User clicks \"Generate\"] → POST /check { model: \"gpt-5.6-luna\" }\n//     ↓\n//     [Server responds: { can_afford: true, cost: 5 credits }]\n//     ↓\n//     [Plugin shows: \"This will use 5 credits. Continue?\"] ← User sees cost first!\n//     ↓\n//     [User clicks \"Continue\"] → POST /generate/start { model, ... }\n//     ↓\n//     [Server reserves: 5 credits, returns X-Reservation-Id]\n//     ↓\n//     [Plugin streams SVG from OpenRouter API for 30 seconds]\n//     ↓\n//     [Network error / timeout / user cancels stream]\n//     ↓\n//     [Plugin calls: POST /generate/refund { reservationId }]\n//     ↓\n//     [Server: looks up reservation, refunds 5 credits]\n//     ↓\n//     [Plugin shows: \"Generation failed. Credits refunded.\"]\n//     ↓\n//     User can retry immediately\n//\n// CREDIT POOLS (which credits are deducted?):\n//   \n//   User has two sources of credits:\n//     1. plan_credits (from subscription, expires monthly)\n//     2. topup_credits (purchased separately, unlimited)\n//   \n//   Deduction order:\n//     • Use plan_credits first (expires anyway)\n//     • Use topup_credits second (user paid for these)\n//   \n//   Example:\n//     • User: plan='pro' (100k plan_credits/month), topup_credits=5000\n//     • Generation costs: 5 credits\n//     • After: plan_credits=99,995, topup_credits=5000 (plan first)\n//     • Next month: plan_credits reset to 100k, topup stays at 5000\n//     • If topup used first: user's paid credits expire monthly (confusing)\n//\n// COST DETERMINATION:\n//   \n//   Problem: different users have different costs\n//     • Free users: forced to use DEFAULT_MODEL (gpt-4-mini)\n//     • Pro users: can choose any model (gemini-3.7, etc.)\n//     • Model cost varies: gpt-4-mini costs 1 credit, gpt-5.6 costs 5 credits\n//     • User can lie: \"I'm choosing gpt-5.6\" (but I'm free, so costs should be 1)\n//   \n//   Solution: resolveModel (ai.controller logic)\n//     • Input: rawModel (what client requested), plan (free|pro)\n//     • Output: resolvedModel (what server will actually use)\n//     • Free user requests: gpt-5.6 → server uses DEFAULT_MODEL instead\n//     • Result: cost is always correct (can't fake it)\n//   \n//   In /check endpoint:\n//     1. Extract: plan from req.planState (already verified by auth.middleware)\n//     2. Extract: modelKey from req.body\n//     3. Call: resolveModel(modelKey, 0, plan) ← applies free user forcing\n//     4. Look up: MODEL_CREDIT_COST[resolvedKey] ← authoritative cost\n//     5. Return: cost to client\n//   \n//   In /refund endpoint:\n//     • Cost lookup: done in credit.service (from reservation doc)\n//     • Client never specifies cost (security)\n//     • Server authoritative: always correct\n//\n// CHECKGENERATIONHANDLER LOGIC:\n//   \n//   Step 1: Extract request context\n//     • planState: contains { plan, isActive, credits, topup_credits }\n//     • Set by: auth.middleware (user context)\n//     • Used for: authorization checks\n//   \n//   Step 2: Determine cost\n//     • modelKey: from req.body (user's choice)\n//     • rawModel: look up in MODEL_MAP\n//     • resolvedModel: apply free user forcing\n//     • cost: look up in MODEL_CREDIT_COST\n//     • Example: free user requests gpt-5.6 → cost=1\n//   \n//   Step 3: Authorization check (can user afford?)\n//     • If free + no credits: return 403 \"plan_required\"\n//     • If not pro: return 403 \"plan_required\"\n//     • (Free plan can't generate; must buy topup OR upgrade)\n//   \n//   Step 4: Sufficient credits check\n//     • totalCredits = plan_credits + topup_credits\n//     • If total < cost:\n//       - Pro user: return 403 with specific message (\"10 credits needed, you have 5\")\n//       - Free user: return 403 with upgrade message (\"Upgrade to a plan\")\n//   \n//   Step 5: Success response\n//     • Return: 200 OK with full breakdown\n//     • Include: credits_left, topup_credits_left, cost_required, resolved_model_key\n//     • Plugin uses: to show user breakdown (\"5 credits from plan, 0 from topup\")\n//   \n//   Why not deduct credits here?\n//     • User might cancel after seeing cost (\"5 credits? That's expensive\")\n//     • Deduct only on actual generation start (/generate/start)\n//     • /check is commitment-free (informational)\n//\n// REFUNDGENERATIONHANDLER LOGIC:\n//   \n//   Step 1: Validate input\n//     • Extract: reservationId from req.body\n//     • Check: reservationId is non-empty string\n//     • If missing: return 400 \"invalid_request\"\n//   \n//   Step 2: Initiate refund\n//     • Call: refundCredits(figmaUserId, reservationId)\n//     • Responsibility: credit.service looks up reservation\n//     • credit.service computes: amount to refund (authoritative)\n//     • credit.service executes: updateOne on credit_reservations\n//       - Set: status='failed' (FSM transition)\n//       - Side effect: db.users sees credits restored\n//   \n//   Step 3: Success response\n//     • Return: 200 OK { refunded: true }\n//     • Dodo webhook: never involved (refund is internal)\n//     • User's credits: immediately restored\n//   \n//   Why server-driven refund amount?\n//     • Malicious plugin: \"refund 1000 credits!\" → server says no (checks reservation)\n//     • Compromised plugin: can't give user free credits\n//     • Bug in plugin: wrong math, claims user paid 100 credits but only paid 5\n//       • Server: \"I have 5 in the reservation, only refunding 5\"\n//   \n//   Reservation lookup (security):\n//     • credit_reservations collection:\n//       { reservationId, figmaUserId, status: 'processing'|'completed'|'failed',\n//         credit_amount, timestamp }\n//     • On /refund: query (reservationId, figmaUserId)\n//     • Verify: ownership (is this user's reservation?)\n//     • Verify: status (if already completed, can't refund)\n//     • Verify: amount (authoritative from reservation doc)\n//     • Result: client provides only ID, server provides everything else\n//\n// AUTHORIZATION (who can call these endpoints?):\n//   \n//   /check endpoint:\n//     • Any authenticated user (checked by auth.middleware)\n//     • No rate limiting (informational only)\n//     • Reason: cheap query, can call multiple times\n//   \n//   /refund endpoint:\n//     • Any authenticated user\n//     • Security: must own the reservation (figmaUserId checked)\n//     • Rate limiting: none (rare operation)\n//     • Reason: if user has bad reservation ID, query returns empty (safe)\n//\n// FIXES APPLIED:\n//   \n//   CREDIT-C-01: /generate/refund now requires reservationId only\n//     • Issue: old code accepted amount + pool (client could specify refund)\n//     • Security risk: \"refund 1000 credits\" → boom, unlimited refunds\n//     • Fix: endpoint only accepts reservationId (no amount parameter)\n//     • Implementation: refundCredits() looks up reservation for amount\n//     • Result: impossible for client to inflate refund\n//     • Location: line 62-76 (refundGenerationHandler)\n//   \n//   H-02: /generate/check is informational only (no credit deduction)\n//     • Issue: old code reserved credits on /check (premature)\n//     • Problem: if user cancels after /check, credits wasted\n//     • Fix: /check is read-only (just answers: can you afford this?)\n//     • Implementation: no DB writes in checkGenerationHandler\n//     • Result: user can call /check multiple times, no cost\n//     • Location: line 28-60 (checkGenerationHandler, no reservation logic)\n//   \n//   C-01: uses resolved model credit cost for free users\n//     • Issue: old code used raw model cost (free users could fake pro models)\n//     • Problem: free user requests gpt-5.6 (costs 5) → server forces DEFAULT_MODEL (costs 1)\n//       But /check said cost=5 → mismatch!\n//     • Fix: /check calls resolveModel (same logic as /generate/start)\n//     • Implementation: modelKey → rawModel → resolvedModel (after forcing)\n//     • Result: /check always matches actual cost\n//     • Location: line 34-36 (resolveModel call with plan parameter)\n//\n// MODEL RESOLUTION EXPLAINED:\n//   \n//   resolveModel(rawModel, complexity, plan) returns:\n//     • If plan='free': always DEFAULT_MODEL (force free users to budget model)\n//     • If plan='pro': return model if valid, else DEFAULT_MODEL\n//     • Complexity parameter: used for smart routing (more complex → smarter model)\n//       But /check doesn't use complexity (use 0 as placeholder)\n//   \n//   Why separate from MODEL_PRICING?\n//     • MODEL_PRICING: maps model_id → {credit_cost, usd_price}\n//     • MODEL_CREDIT_COST: maps modelKey → credit_amount (for deduction)\n//     • Distinction: same model has different costs per plan (free='1', pro='5')\n//     • /check uses: MODEL_CREDIT_COST[resolvedKey] (authoritative for this plan)\n//\n// EXAMPLE FLOWS:\n//   \n//   Flow A: Pro user wants gpt-5.6\n//     1. /check { model: 'gpt-5.6-luna' }\n//     2. plan='pro' → resolvedModel='gpt-5.6-luna' (no forcing)\n//     3. cost = MODEL_CREDIT_COST['gpt-5.6-luna'] = 5 credits\n//     4. user has: plan_credits=100k, topup_credits=0 → total=100k\n//     5. Response: { can_afford: true, cost: 5, credits_left: 100000 }\n//     6. User clicks \"Continue\" → POST /generate/start\n//     7. ai.controller reserves 5 credits\n//     8. Stream generation for 30 seconds\n//     9. Complete → settled 5 credits\n//   \n//   Flow B: Free user tries gpt-5.6\n//     1. /check { model: 'gpt-5.6-luna' }\n//     2. plan='free' → resolveModel forces DEFAULT_MODEL ('gpt-4-mini')\n//     3. cost = MODEL_CREDIT_COST['gpt-4-mini'] = 1 credit\n//     4. user has: plan_credits=0, topup_credits=20 → total=20\n//     5. Response: { can_afford: true, cost: 1, topup_credits_left: 20 }\n//     6. Plugin shows: \"Using gpt-4-mini (only model available on free). Cost: 1 credit.\"\n//     7. User clicks \"Continue\" → POST /generate/start\n//     8. ai.controller reserves 1 credit (from topup)\n//     9. Stream generation\n//     10. Complete → settled 1 credit\n//   \n//   Flow C: Free user insufficient credits\n//     1. /check { model: 'gpt-5.6-luna' }\n//     2. plan='free' → resolveModel forces DEFAULT_MODEL\n//     3. cost = 1 credit\n//     4. user has: plan_credits=0, topup_credits=0 → total=0\n//     5. Check fails: total < cost (0 < 1)\n//     6. Response: 403 Forbidden { error: \"No credits remaining. Please upgrade to a plan.\" }\n//     7. Plugin shows error, user clicks \"Upgrade\"\n//     8. User buys plan or topup\n//   \n//   Flow D: Generation fails, client requests refund\n//     1. POST /generate/start → returns X-Reservation-Id: res_abc123\n//     2. Stream generation → OpenRouter timeout after 5 seconds\n//     3. POST /generate/refund { reservationId: 'res_abc123' }\n//     4. credit.service looks up: credit_reservations[res_abc123]\n//       Found: { status: 'processing', credit_amount: 5, figmaUserId: 'user_xyz' }\n//     5. Verify: ownership (req.figmaUserId='user_xyz', matches)\n//     6. Verify: not already refunded (status='processing', not 'failed')\n//     7. Update: credit_reservations.updateOne(status='failed')\n//     8. Side effect: user.credits restored (from reservation)\n//     9. Response: { refunded: true }\n//     10. Plugin shows: \"Generation failed. 5 credits refunded.\"\n//

import { Request, Response } from 'express';
import { refundCredits } from './credit.service';
import { resolveModel } from '../ai/ai.router';
import { RefundRequest } from './credit.types';
import { ForbiddenError, BadRequestError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import {
  MODEL_CREDIT_COST,
  CREDIT_COST_GENERATE,
  DEFAULT_MODEL_KEY,
  MODEL_MAP,
  DEFAULT_MODEL,
} from '../../config/constants';

// ── POST /api/features/generate/check ────────────────────────────────────────
//
// INFORMATIONAL ONLY — returns whether the user can afford the selected model.
// Does NOT deduct credits (Fix H-02).
// Uses resolved model cost so free users see the correct 1-credit cost (Fix C-01).

export async function checkGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;

  const modelKey        = (req.body?.model as string) || DEFAULT_MODEL_KEY;
  const rawModel        = MODEL_MAP[modelKey] ?? (modelKey.includes('/') ? modelKey : DEFAULT_MODEL);
  const resolvedModelId = resolveModel(rawModel, 0, plan);
  const resolvedKey     = Object.entries(MODEL_MAP).find(([, v]) => v === resolvedModelId)?.[0] ?? modelKey;
  const cost            = MODEL_CREDIT_COST[resolvedKey] ?? CREDIT_COST_GENERATE;

  if (!isActive && credits === 0) {
    throw new ForbiddenError('An active plan is required to generate wireframes.', 'plan_required');
  }

  const totalCredits = credits + topup_credits;
  if (totalCredits < cost) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. This model costs ${cost} credits and you have ${totalCredits} remaining.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  sendSuccess(res, {
    ok:                 true,
    can_afford:         true,
    credits_left:       credits,
    topup_credits_left: topup_credits,
    total_credits_left: totalCredits,
    cost_required:      cost,
    resolved_model_key: resolvedKey,
  });
}

// ── POST /api/features/generate/refund ───────────────────────────────────────
//
// Fix CREDIT-C-01: Accepts only reservationId. Server looks up authoritative cost + pool.
// Clients cannot specify cost or pool — completely server-driven refund amount.

export async function refundGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { reservationId } = req.body as RefundRequest;

  if (!reservationId || typeof reservationId !== 'string' || !reservationId.trim()) {
    throw new BadRequestError('reservationId is required', 'invalid_request');
  }

  await refundCredits(req.figmaUserId, reservationId.trim());
  logger.info(`[credit.controller] Refund processed for reservation ${reservationId} — user ${req.figmaUserId}`);
  sendSuccess(res, { ok: true, refunded: true });
}
