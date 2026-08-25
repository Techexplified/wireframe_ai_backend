// ─── __tests__/payment.routes.test.ts ─────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initCheckoutHandler, topupCheckoutHandler } from '../modules/payments/payment.controller';
import { BadRequestError, ConflictError, ForbiddenError, AppError } from '../utils/errors';
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

describe('Payment Controller & Checkout Route Logic', () => {
  describe('POST /api/checkout/init', () => {
    it('throws BadRequestError (400) when planId is missing or invalid', async () => {
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

      const req: any = { body: { planId: 'enterprise' }, planState, figmaUserId: 'usr_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await initCheckoutHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_plan');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('throws ConflictError (409) when user already has an active Pro subscription', async () => {
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 100,
        topup_credits: 0,
        days_left: 30,
        subscription_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_123',
      };

      const req: any = { body: { planId: 'pro' }, planState, figmaUserId: 'usr_pro_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await initCheckoutHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ConflictError);
          assert.strictEqual(err.errorCode, 'already_on_plan');
          assert.strictEqual(err.statusCode, 409);
          return true;
        }
      );
    });

    it('throws AppError (500) when DODO_API_KEY is not configured', async () => {
      const originalKey = process.env.DODO_API_KEY;
      process.env.DODO_API_KEY = '';

      const planState: PlanState = {
        plan: 'free',
        isActive: false,
        credits: 0,
        topup_credits: 0,
        days_left: 0,
        subscription_ends_at: null,
        subscription_cancelled: false,
        dodo_subscription_id: null,
      };

      const req: any = { body: { planId: 'pro' }, planState, figmaUserId: 'usr_free_123' };
      const { res } = createMockResponse();

      try {
        await assert.rejects(
          async () => {
            await initCheckoutHandler(req, res);
          },
          (err: any) => {
            assert.ok(err instanceof AppError);
            assert.strictEqual(err.errorCode, 'configuration_error');
            assert.strictEqual(err.statusCode, 500);
            return true;
          }
        );
      } finally {
        process.env.DODO_API_KEY = originalKey;
      }
    });
  });

  describe('POST /api/checkout/topup', () => {
    it('throws ForbiddenError (403) when a Free user attempts to purchase topup credits', async () => {
      const planState: PlanState = {
        plan: 'free',
        isActive: false,
        credits: 0,
        topup_credits: 0,
        days_left: 0,
        subscription_ends_at: null,
        subscription_cancelled: false,
        dodo_subscription_id: null,
      };

      const req: any = { body: { packId: 'small' }, planState, figmaUserId: 'usr_free_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await topupCheckoutHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'plan_required');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when packId is invalid', async () => {
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 50,
        topup_credits: 0,
        days_left: 20,
        subscription_ends_at: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_123',
      };

      const req: any = { body: { packId: 'unlimited' }, planState, figmaUserId: 'usr_pro_123' };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await topupCheckoutHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_pack');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });
  });
});
