// ─── __tests__/middleware.test.ts ───────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireProMiddleware } from '../middleware/require-pro.middleware';
import { checkoutRateLimitMiddleware } from '../middleware/checkout.rate-limit.middleware';
import { errorHandler } from '../middleware/error.middleware';
import { ForbiddenError, AppError } from '../utils/errors';
import { PlanState } from '../modules/users/user.types';

function createMockResponse() {
  let statusCode = 200;
  let body: any = null;
  const headers: Record<string, any> = {};

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    setHeader(name: string, value: any) {
      headers[name.toLowerCase()] = value;
      return res;
    },
  };

  return {
    res,
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
}

describe('Express Middlewares Suite', () => {
  describe('auth.middleware', () => {
    it('sends 401 Unauthorized when x-figma-user-id header is missing', async () => {
      const req: any = { headers: {} };
      const { res, getStatusCode, getBody } = createMockResponse();

      let nextCalled = false;
      await authMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(getStatusCode(), 401);
      assert.strictEqual(getBody().error, 'missing_user_id');
    });

    it('sends 401 Unauthorized when x-figma-user-id is blank whitespace', async () => {
      const req: any = { headers: { 'x-figma-user-id': '   ' } };
      const { res, getStatusCode, getBody } = createMockResponse();

      let nextCalled = false;
      await authMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(getStatusCode(), 401);
      assert.strictEqual(getBody().error, 'missing_user_id');
    });
  });

  describe('require-pro.middleware', () => {
    it('throws ForbiddenError (403) when user is not an active Pro subscriber', () => {
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

      const req: any = { planState };
      const { res } = createMockResponse();

      assert.throws(
        () => {
          requireProMiddleware(req, res, () => {});
        },
        (err: any) => {
          assert.ok(err instanceof ForbiddenError);
          assert.strictEqual(err.statusCode, 403);
          assert.strictEqual(err.errorCode, 'pro_plan_required');
          return true;
        }
      );
    });

    it('calls next() successfully when user has an active Pro subscription', () => {
      const planState: PlanState = {
        plan: 'pro',
        isActive: true,
        credits: 100,
        topup_credits: 0,
        days_left: 30,
        subscription_ends_at: new Date(),
        subscription_cancelled: false,
        dodo_subscription_id: 'sub_123',
      };

      const req: any = { planState };
      const { res } = createMockResponse();

      let nextCalled = false;
      requireProMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
    });
  });

  describe('checkout.rate-limit.middleware', () => {
    it('blocks request with 429 when checkout rate limit is exceeded', async () => {
      const userId = `usr_ratelimit_${Date.now()}`;
      const req: any = { figmaUserId: userId, ip: '127.0.0.1' };
      const { res } = createMockResponse();

      let receivedErr: any = null;
      for (let i = 0; i < 16; i++) {
        await checkoutRateLimitMiddleware(req, res, (err?: any) => {
          if (err) receivedErr = err;
        });
      }

      assert.ok(receivedErr instanceof AppError);
      assert.strictEqual(receivedErr.statusCode, 429);
      assert.strictEqual(receivedErr.errorCode, 'rate_limit_exceeded');
    });
  });

  describe('error.middleware', () => {
    it('formats AppError into standardized error response', () => {
      const appErr = new ForbiddenError('Access forbidden test', 'forbidden_test');
      const req: any = {};
      const { res, getStatusCode, getBody } = createMockResponse();

      errorHandler(appErr, req, res, () => {});

      assert.strictEqual(getStatusCode(), 403);
      const body = getBody();
      assert.strictEqual(body.error, 'forbidden_test');
      assert.strictEqual(body.message, 'Access forbidden test');
    });
  });
});
