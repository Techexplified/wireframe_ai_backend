// ─── modules/ai/middleware/ai.quota.middleware.ts ─────────────────────────────
//
// Daily token quota enforcement per user.
// Tracked in MongoDB `daily_token_quotas` collection with UTC-day granularity.
// Documents auto-expire after 2 days via TTL index.
//
// Quotas per plan:
//   Free:    15,000 tokens / day
//   Starter: 150,000 tokens / day
//   Pro:     500,000 tokens / day

import { Request, Response, NextFunction } from 'express';
import { connectToDatabase } from '../../../config/database';
import { DAILY_TOKEN_QUOTA } from '../../../config/constants';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

interface DailyQuotaDoc {
  figmaUserId: string;
  date: string;       // YYYY-MM-DD UTC
  tokensUsed: number;
  createdAt: Date;
}

function getTodayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function aiQuotaMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const figmaUserId = req.figmaUserId;
  const plan        = req.planState.plan;
  const quota       = DAILY_TOKEN_QUOTA[plan];
  const today       = getTodayUTC();

  try {
    const db  = await connectToDatabase();
    const col = db.collection<DailyQuotaDoc>('daily_token_quotas');

    const doc = await col.findOne({ figmaUserId, date: today });

    if (doc && doc.tokensUsed >= quota) {
      throw new AppError(
        `Daily token quota reached for your ${plan} plan (${quota.toLocaleString()} tokens). Quota resets at midnight UTC.`,
        429,
        'daily_quota_exceeded'
      );
    }

    next();
  } catch (err) {
    logger.warn('[ai.quota] Error:', err);
    next(err);
  }
}

/**
 * Called after generation completes to increment today's token count.
 * Non-blocking — errors here are non-fatal.
 */
export async function incrementDailyTokenUsage(
  figmaUserId: string,
  tokensUsed: number
): Promise<void> {
  try {
    const db    = await connectToDatabase();
    const col   = db.collection<DailyQuotaDoc>('daily_token_quotas');
    const today = getTodayUTC();

    await col.findOneAndUpdate(
      { figmaUserId, date: today },
      {
        $inc:         { tokensUsed },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn('[ai.quota] Failed to update daily token usage:', err);
  }
}
