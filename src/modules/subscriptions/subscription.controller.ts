// ─── modules/subscriptions/subscription.controller.ts — Subscription Handlers ─

import { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response';
import { SubscriptionStatusResponse } from './subscription.types';
import { cancelSubscription, reactivateSubscription } from '../payments/providers/dodo.provider';
import { getUsersCollection } from '../../config/database';
import { ForbiddenError, ConflictError } from '../../utils/errors';
import { logger } from '../../utils/logger';

// ── GET /api/subscription/status ─────────────────────────────────────────────

export async function getSubscriptionStatusHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits, days_left, subscription_ends_at, subscription_cancelled } = req.planState;

  const totalCredits = credits + topup_credits;

  const responseData: SubscriptionStatusResponse = {
    plan,
    isActive,
    credits,
    topup_credits,
    total_credits:          totalCredits,
    days_left,
    subscription_ends_at:   subscription_ends_at?.toISOString() ?? null,
    subscription_cancelled: subscription_cancelled ?? false,
    show_upgrade:           !isActive,
    show_topup:             isActive,
    show_renew:             !isActive && credits === 0,
    is_trial:               plan === 'free' && credits > 0,
  };

  sendSuccess(res, responseData);
}

// ── POST /api/subscription/cancel ────────────────────────────────────────────

export async function cancelSubscriptionHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, subscription_ends_at } = req.planState;
  const figmaUserId = req.figmaUserId;

  if (!isActive || plan !== 'pro') {
    throw new ForbiddenError('No active Pro subscription to cancel.', 'not_subscribed');
  }

  const users = await getUsersCollection();
  const user  = await users.findOne({ figmaUserId });

  if (user?.subscription_cancelled) {
    throw new ConflictError('Subscription is already scheduled for cancellation at the end of the billing period.', 'already_cancelled');
  }

  // If a Dodo subscription ID is present, request scheduled cancellation on Dodo
  if (user?.dodo_subscription_id) {
    try {
      logger.info(`[subscription.controller] Cancelling Dodo subscription ${user.dodo_subscription_id} for user ${figmaUserId}`);
      await cancelSubscription(user.dodo_subscription_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[subscription.controller] Dodo cancel API call warning for ${user.dodo_subscription_id}: ${msg} — proceeding with local cancellation`);
    }
  } else {
    logger.info(`[subscription.controller] No dodo_subscription_id found for ${figmaUserId} (testing/legacy account) — applying local cancellation`);
  }

  const now = new Date();
  await users.updateOne(
    { figmaUserId },
    { $set: { subscription_cancelled: true, updatedAt: now } }
  );

  sendSuccess(res, {
    cancelled:            true,
    subscription_ends_at: subscription_ends_at?.toISOString() ?? user?.subscription_ends_at?.toISOString() ?? null,
    message:              'Your subscription will not renew next cycle. You retain full Pro access and credits until your current period ends.',
  });
}

// ── POST /api/subscription/reactivate ────────────────────────────────────────

export async function reactivateSubscriptionHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, subscription_ends_at } = req.planState;
  const figmaUserId = req.figmaUserId;

  if (!isActive || plan !== 'pro') {
    throw new ForbiddenError('No active Pro subscription to reactivate.', 'not_subscribed');
  }

  const users = await getUsersCollection();
  const user  = await users.findOne({ figmaUserId });

  if (!user?.subscription_cancelled) {
    throw new ConflictError('Subscription is not scheduled for cancellation. Auto-renewal is already active.', 'not_cancelled');
  }

  // If a Dodo subscription ID is present, request reactivation on Dodo
  if (user?.dodo_subscription_id) {
    try {
      logger.info(`[subscription.controller] Reactivating Dodo subscription ${user.dodo_subscription_id} for user ${figmaUserId}`);
      await reactivateSubscription(user.dodo_subscription_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[subscription.controller] Dodo reactivate API call warning for ${user.dodo_subscription_id}: ${msg} — proceeding with local reactivation`);
    }
  } else {
    logger.info(`[subscription.controller] No dodo_subscription_id found for ${figmaUserId} (testing/legacy account) — applying local reactivation`);
  }

  const now = new Date();
  await users.updateOne(
    { figmaUserId },
    { $set: { subscription_cancelled: false, updatedAt: now } }
  );

  sendSuccess(res, {
    reactivated:          true,
    subscription_ends_at: subscription_ends_at?.toISOString() ?? user?.subscription_ends_at?.toISOString() ?? null,
    message:              'Auto-renewal reactivated! Your Pro plan will renew automatically on your next billing date.',
  });
}
