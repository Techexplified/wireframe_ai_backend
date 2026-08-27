// ─── __tests__/credit.routes.test.ts ──────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkGenerationHandler, refundGenerationHandler } from '../modules/credits/credit.controller';
import { ForbiddenError, BadRequestError } from '../utils/errors';
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

describe('Credit Controller & Generation Pre-Flight / Refund Logic', () => {
  describe('POST /api/features/generate/check', () => {
    it('returns can_afford: true with cost_required for affordable model', async () => {
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

      const req: any = {
        body: { model: 'gpt-5-6-luna' },
        planState,
        figmaUserId: 'usr_free_123',
      };
      const { res, getBody, getStatusCode } = createMockResponse();

      await checkGenerationHandler(req, res);

      assert.strictEqual(getStatusCode(), 200);
      const data = getBody();
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.can_afford, true);
      assert.strictEqual(data.credits_left, 3);
      assert.strictEqual(data.cost_required, 1);
    });

    it('throws ForbiddenError (403) when user has 0 credits and inactive plan', async () => {
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

      const req: any = {
        body: { model: 'gpt-5-6-luna' },
        planState,
        figmaUserId: 'usr_free_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await checkGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'plan_required');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });

    it('throws ForbiddenError (403) when user credits are less than model cost', async () => {
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 1,
        topup_credits: 0,
        days_left: 10,
        subscription_ends_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_123',
      };

      // gemini-3-7 costs 2 credits
      const req: any = {
        body: { model: 'gemini-3-7' },
        planState,
        figmaUserId: 'usr_pro_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await checkGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'insufficient_credits');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });
  });

  describe('POST /api/features/generate/refund', () => {
    it('throws BadRequestError (400) when reservationId is missing', async () => {
      const req: any = {
        body: {},
        figmaUserId: 'usr_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await refundGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_request');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when reservationId is whitespace only', async () => {
      const req: any = {
        body: { reservationId: '   ' },
        figmaUserId: 'usr_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await refundGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_request');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });
  });
});
