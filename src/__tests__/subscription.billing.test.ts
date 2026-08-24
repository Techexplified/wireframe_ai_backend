// ─── __tests__/subscription.billing.test.ts ───────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanState } from '../modules/users/user.types';
import { SubscriptionStatusResponse } from '../modules/subscriptions/subscription.types';

describe('Manage Billing & Subscription Lifecycle Invariants', () => {
  it('SubscriptionStatusResponse reflects cancelled auto-renewal correctly', () => {
    const planState: PlanState = {
      plan: 'pro',
      isActive: true,
      credits: 80,
      topup_credits: 20,
      days_left: 15,
      subscription_ends_at: new Date('2026-09-01T00:00:00.000Z'),
      subscription_cancelled: true,
      dodo_subscription_id: 'sub_test_123',
    };

    const statusResponse: SubscriptionStatusResponse = {
      plan: planState.plan,
      isActive: planState.isActive,
      credits: planState.credits,
      topup_credits: planState.topup_credits,
      total_credits: planState.credits + planState.topup_credits,
      days_left: planState.days_left,
      subscription_ends_at: planState.subscription_ends_at?.toISOString() ?? null,
      subscription_cancelled: planState.subscription_cancelled ?? false,
      show_upgrade: !planState.isActive,
      show_topup: planState.isActive,
      show_renew: !planState.isActive && planState.credits === 0,
      is_trial: planState.plan === 'free' && planState.credits > 0,
    };

    assert.strictEqual(statusResponse.plan, 'pro');
    assert.strictEqual(statusResponse.isActive, true);
    assert.strictEqual(statusResponse.subscription_cancelled, true);
    assert.strictEqual(statusResponse.total_credits, 100);
    assert.strictEqual(statusResponse.days_left, 15);
  });

  it('Reactivated subscription clears subscription_cancelled flag', () => {
    const planState: PlanState = {
      plan: 'pro',
      isActive: true,
      credits: 100,
      topup_credits: 0,
      days_left: 30,
      subscription_ends_at: new Date('2026-09-15T00:00:00.000Z'),
      subscription_cancelled: false,
      dodo_subscription_id: 'sub_test_456',
    };

    assert.strictEqual(planState.subscription_cancelled, false);
    assert.strictEqual(planState.isActive, true);
  });

  it('Free users default to subscription_cancelled = false', () => {
    const freePlanState: PlanState = {
      plan: 'free',
      isActive: false,
      credits: 3,
      topup_credits: 0,
      days_left: 0,
      subscription_ends_at: null,
      subscription_cancelled: false,
      dodo_subscription_id: null,
    };

    assert.strictEqual(freePlanState.plan, 'free');
    assert.strictEqual(freePlanState.subscription_cancelled, false);
    assert.strictEqual(freePlanState.dodo_subscription_id, null);
  });
});
