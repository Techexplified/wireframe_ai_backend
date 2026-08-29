// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── types/express.d.ts — Express Request Type Augmentation
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Extends Express Request interface with application-specific properties.
//   Attached by middleware so controllers can access without casting.
//   Provides type-safe request context throughout the application.
//
// TYPESCRIPT DECLARATION MERGING:
//   This file uses TypeScript's "declaration merging" pattern.
//   Extends global Express.Request with custom properties.
//   All handlers see these properties with full type safety (no unsafe any casts).
//
// ATTACHED PROPERTIES:
//   
//   req.figmaUserId: string
//     • Attached by authMiddleware
//     • Unique identifier for the Figma user making the request
//     • Used as primary key in databases (users, credit_reservations, etc.)
//     • Guaranteed to be present after authMiddleware (or 401 thrown)
//     • Cannot be spoofed (verified against Firebase UID binding)
//   
//   req.planState: PlanState
//     • Attached by authMiddleware via getActivePlanState()
//     • Contains user's subscription state: plan, isActive, credits, topup_credits, etc.
//     • Fresh on every request (loaded from MongoDB users collection)
//     • Reflects current state: plan type, subscription expiration, credit balance
//     • Used by controllers to:
//       - Check if user has active Pro plan (requireProMiddleware)
//       - Determine model selection (free → DEFAULT_MODEL, pro → user choice)
//       - Calculate credit costs (plan-aware pricing)
//       - Guard endpoints (check isActive before deducting credits)
//   
//   req._aiComplexity?: ComplexityResult (optional)
//     • Attached by aiBudgetMiddleware ONLY if prompt present in request
//     • Pre-computed complexity score (1-10) of user's prompt
//     • Includes: score, sectionCount, promptLength, device, tokenBudget
//     • Consumed by:
//       - ai.controller.ts: uses _complexity to determine model routing
//       - ai.service.ts: passes _complexity to OpenRouter for max_tokens calculation
//     • Prefix '_' indicates: internal/private, for optimization only, not for display
//     • Prevents double-scoring: aiBudgetMiddleware scores once, service uses cached result
//     • Performance: complexity scoring is O(prompt_length), caching avoids repeat work
//
// USAGE PATTERN IN CONTROLLERS:
//   Instead of unsafe casting:
//     const figmaUserId = (req as any).figmaUserId;
//   
//   Use type-safe access:
//     const figmaUserId = req.figmaUserId;  // TypeScript knows this exists
//
// MIDDLEWARE ATTACHMENT FLOW:
//   1. authMiddleware runs: verifies JWT, loads planState
//   2. Sets: req.figmaUserId, req.planState
//   3. aiBudgetMiddleware runs (if /api/features/generate route):
//      - Scores complexity, sets req._aiComplexity
//   4. Controller runs: accesses req.figmaUserId, req.planState, req._aiComplexity
//
// ERROR IF MISSING:
//   If controller receives request WITHOUT figmaUserId or planState:
//     • authMiddleware failed to run (configuration error)
//     • Route not protected by authMiddleware (developer error)
//     • TypeScript would show error (property doesn't exist on Request)
//   
//   This prevents silent bugs (unauthed requests reaching controllers)

import { PlanState } from '../modules/users/user.types';
import { ComplexityResult } from '../modules/ai/ai.types';

declare global {
  namespace Express {
    interface Request {
      figmaUserId: string;
      planState: PlanState;
      /** Pre-computed complexity score from aiBudgetMiddleware — avoids double-scoring in ai.service */
      _aiComplexity?: ComplexityResult;
    }
  }
}
