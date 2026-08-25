// ─── __tests__/ai.routes.test.ts ──────────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startGenerationHandler } from '../modules/ai/ai.controller';
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

describe('AI Controller & Wireframe Generation Route Logic', () => {
  describe('POST /api/features/generate/start', () => {
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
        body: { prompt: 'SaaS analytics dashboard' },
        planState,
        figmaUserId: 'usr_free_0cred',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await startGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'plan_required');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });

    it('throws ForbiddenError (403) when user has fewer credits than required model cost', async () => {
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 1,
        topup_credits: 0,
        days_left: 14,
        subscription_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_123',
      };

      // gpt-4o costs 4 credits
      const req: any = {
        body: { prompt: 'E-commerce checkout flow', model: 'gpt-4o' },
        planState,
        figmaUserId: 'usr_pro_lowcred',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await startGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.errorCode, 'insufficient_credits');
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when prompt is empty or whitespace', async () => {
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
        body: { prompt: '   ' },
        planState,
        figmaUserId: 'usr_free_valid',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await startGenerationHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_request');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when prompt is missing entirely', async () => {
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
        body: {},
        planState,
        figmaUserId: 'usr_free_valid',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await startGenerationHandler(req, res);
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
