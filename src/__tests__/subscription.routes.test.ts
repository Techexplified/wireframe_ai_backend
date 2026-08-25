// ─── __tests__/subscription.routes.test.ts ───────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSubscriptionStatusHandler, cancelSubscriptionHandler, reactivateSubscriptionHandler } from '../modules/subscriptions/subscription.controller';
import { ForbiddenError } from '../utils/errors';
import { PlanState } from '../modules/users/user.types';

function createMockResponse() {
  let statusCode = 200;
  let body: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
  };
  return {
    res,
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
}

describe('Subscription Controller & Route Logic', () => {
  describe('GET /api/subscription/status', () => {
    it('returns correct subscription status response for free trial user', async () => {
      const planState: PlanState = {
        plan: 'free',
        isActive: false,
        credits: 3,
        topup_credits: 0,
        days_left: 0,
        subscription_ends_at: null,
        subscription_cancelled: false,
        dodo_subscription_id: null,
      };

      const req: any = { planState, figmaUserId: 'usr_free_123' };
      const { res, getBody, getStatusCode } = createMockResponse();

      await getSubscriptionStatusHandler(req, res);

      assert.strictEqual(getStatusCode(), 200);
      const data = getBody();
      assert.strictEqual(data.plan, 'free');
      assert.strictEqual(data.isActive, false);
      assert.strictEqual(data.credits, 3);
      assert.strictEqual(data.topup_credits, 0);
      assert.strictEqual(data.total_credits, 3);
      assert.strictEqual(data.show_upgrade, true);
      assert.strictEqual(data.show_topup, false);
      assert.strictEqual(data.is_trial, true);
    });

    it('returns correct subscription status response for active Pro subscriber', async () => {
      const endsAt = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 90,
        topup_credits: 20,
        days_left: 25,
        subscription_ends_at: endsAt,
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_active_456',
      };

      const req: any = { planState, figmaUserId: 'usr_pro_123' };
      const { res, getBody, getStatusCode } = createMockResponse();

      await getSubscriptionStatusHandler(req, res);

      assert.strictEqual(getStatusCode(), 200);
      const data = getBody();
      assert.strictEqual(data.plan, 'pro');
      assert.strictEqual(data.isActive, true);
      assert.strictEqual(data.credits, 90);
      assert.strictEqual(data.topup_credits, 20);
      assert.strictEqual(data.total_credits, 110);
      assert.strictEqual(data.show_upgrade, false);
      assert.strictEqual(data.show_topup, true);
      assert.strictEqual(data.is_trial, false);
      assert.strictEqual(data.subscription_cancelled, false);
    });
  });

  describe('POST /api/subscription/cancel', () => {
    it('throws ForbiddenError (403) when non-Pro user tries to cancel', async () => {
      const planState: PlanState = {
        plan: 'free',
        isActive: false,
        credits: 2,
        topup_credits: 0,
        days_left: 0,
        subscription_ends_at: null,
        subscription_cancelled: false,
        dodo_subscription_id: null,
      };

      const req: any = { planState, figmaUserId: 'usr_free_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await cancelSubscriptionHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'not_subscribed');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });
  });

  describe('POST /api/subscription/reactivate', () => {
    it('throws ForbiddenError (403) when non-Pro user tries to reactivate', async () => {
      const planState: PlanState = {
        plan: 'free',
        isActive: false,
        credits: 1,
        topup_credits: 0,
        days_left: 0,
        subscription_ends_at: null,
        subscription_cancelled: false,
        dodo_subscription_id: null,
      };

      const req: any = { planState, figmaUserId: 'usr_free_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await reactivateSubscriptionHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'not_subscribed');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });
  });
});
