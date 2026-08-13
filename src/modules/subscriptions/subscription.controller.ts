// ─── modules/subscriptions/subscription.controller.ts — Subscription Handlers ─

import { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response';
import { SubscriptionStatusResponse } from './subscription.types';

// ── GET /api/subscription/status ─────────────────────────────────────────────

export async function getSubscriptionStatusHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits, days_left, subscription_ends_at } = req.planState;

  const totalCredits = credits + topup_credits;

  const responseData: SubscriptionStatusResponse = {
    plan,
    isActive,
    credits,
    topup_credits,
    total_credits:        totalCredits,
    days_left,
    subscription_ends_at: subscription_ends_at?.toISOString() ?? null,
    show_upgrade:         !isActive,
    show_topup:           isActive,
    show_renew:           !isActive && credits === 0,
    is_trial:             plan === 'free' && credits > 0,
  };

  sendSuccess(res, responseData);
}
