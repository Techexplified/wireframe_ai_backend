// ─── types/express.d.ts — Express Request type augmentation ──────────────────
//
// Extends the Express Request interface to include:
//   - Figma user context attached by auth.middleware.ts
//   - AI complexity result attached by aiBudgetMiddleware

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
