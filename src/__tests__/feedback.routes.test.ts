// ─── __tests__/feedback.routes.test.ts ───────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitFeedbackHandler } from '../modules/feedback/feedback.controller';
import { BadRequestError } from '../utils/errors';

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

describe('Feedback Controller Logic', () => {
  describe('POST /api/feedback/submit validation', () => {
    it('throws BadRequestError (400) when rating is missing', async () => {
      const req: any = {
        body: { message: 'Great plugin!' },
        figmaUserId: 'usr_test_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await submitFeedbackHandler(req, res);
        },
        (err: any) => {
          assert(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_rating');
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when rating is out of bounds (< 1 or > 5)', async () => {
      const req: any = {
        body: { rating: 6 },
        figmaUserId: 'usr_test_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await submitFeedbackHandler(req, res);
        },
        (err: any) => {
          assert(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_rating');
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when rating is a float', async () => {
      const req: any = {
        body: { rating: 4.5 },
        figmaUserId: 'usr_test_123',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await submitFeedbackHandler(req, res);
        },
        (err: any) => {
          assert(err instanceof BadRequestError);
          return true;
        }
      );
    });
  });

  describe('GET /api/feedback/summary error handling', () => {
    it('requires MONGODB_URI when querying summary in unconfigured test env', async () => {
      const req: any = {
        headers: {},
        figmaUserId: 'usr_test_123',
        planState: { plan: 'free', isActive: false },
      };
      const { res } = createMockResponse();

      const { getFeedbackSummaryHandler } = await import('../modules/feedback/feedback.controller');
      if (!process.env.MONGODB_URI) {
        await assert.rejects(
          async () => {
            await getFeedbackSummaryHandler(req, res);
          },
          (err: any) => {
            assert.ok(err.message.includes('MONGODB_URI'));
            return true;
          }
        );
      }
    });
  });
});
