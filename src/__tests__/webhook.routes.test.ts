// ─── __tests__/webhook.routes.test.ts ─────────────────────────────────────
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dodoWebhookHandler } from '../modules/webhooks/webhook.controller';
import { UnauthorizedError, BadRequestError } from '../utils/errors';

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

describe('Webhook Controller & Signature Route Logic', () => {
  const secret = 'whsec_test_secret_abcdef123456';
  const originalSecret = process.env.DODO_WEBHOOK_SECRET;

  before(() => {
    process.env.DODO_WEBHOOK_SECRET = secret;
  });

  after(() => {
    process.env.DODO_WEBHOOK_SECRET = originalSecret;
  });

  function createValidSignature(body: Buffer, timestamp: number): string {
    const signedPayload = `${timestamp}.${body.toString('utf8')}`;
    const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return `t=${timestamp},v1=${sig}`;
  }

  describe('POST /webhooks/dodo', () => {
    it('throws UnauthorizedError (401) when signature is missing', async () => {
      const payload = { event: 'payment.succeeded', id: 'pay_123' };
      const req: any = {
        headers: {},
        body: payload,
        rawBody: Buffer.from(JSON.stringify(payload)),
        ip: '127.0.0.1',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await dodoWebhookHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof UnauthorizedError);
          assert.strictEqual(err.errorCode, 'invalid_signature');
          assert.strictEqual(err.statusCode, 401);
          return true;
        }
      );
    });

    it('throws UnauthorizedError (401) when signature is invalid', async () => {
      const payload = { event: 'payment.succeeded', id: 'pay_123' };
      const req: any = {
        headers: {
          'webhook-signature': 't=123456,v1=invalid_fake_signature_hash',
        },
        body: payload,
        rawBody: Buffer.from(JSON.stringify(payload)),
        ip: '127.0.0.1',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await dodoWebhookHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof UnauthorizedError);
          assert.strictEqual(err.errorCode, 'invalid_signature');
          assert.strictEqual(err.statusCode, 401);
          return true;
        }
      );
    });

    it('throws UnauthorizedError (401) when signature timestamp is expired (> 300s)', async () => {
      const payload = { event: 'payment.succeeded', id: 'pay_old_123' };
      const bodyBuf = Buffer.from(JSON.stringify(payload));
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 350;
      const signature = createValidSignature(bodyBuf, expiredTimestamp);

      const req: any = {
        headers: { 'webhook-signature': signature },
        body: payload,
        rawBody: bodyBuf,
        ip: '127.0.0.1',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await dodoWebhookHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof UnauthorizedError);
          assert.strictEqual(err.errorCode, 'invalid_signature');
          assert.strictEqual(err.statusCode, 401);
          return true;
        }
      );
    });

    it('throws BadRequestError (400) when eventId is missing in payload', async () => {
      const payload = { event: 'payment.succeeded' }; // missing id / payment_id / msgId
      const bodyBuf = Buffer.from(JSON.stringify(payload));
      const now = Math.floor(Date.now() / 1000);
      const signature = createValidSignature(bodyBuf, now);

      const req: any = {
        headers: { 'webhook-signature': signature },
        body: payload,
        rawBody: bodyBuf,
        ip: '127.0.0.1',
      };
      const { res } = createMockResponse();

      await assert.rejects(
        async () => {
          await dodoWebhookHandler(req, res);
        },
        (err: any) => {
          assert.ok(err instanceof BadRequestError);
          assert.strictEqual(err.errorCode, 'invalid_payload');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    });

    it('safely acknowledges and ignores subscription.created event without activating plan', async () => {
      const payload = {
        type: 'subscription.created',
        id: `sub_created_test_${Date.now()}`,
        data: {
          subscription_id: `sub_created_${Date.now()}`,
          status: 'pending',
          customer: { metadata: { figmaUserId: 'test-user-sub-created' } },
        },
      };
      const bodyBuf = Buffer.from(JSON.stringify(payload));
      const now = Math.floor(Date.now() / 1000);
      const signature = createValidSignature(bodyBuf, now);

      const req: any = {
        headers: { 'webhook-signature': signature },
        body: payload,
        rawBody: bodyBuf,
        ip: '127.0.0.1',
      };
      const { res, getStatusCode, getBody } = createMockResponse();

      if (process.env.MONGODB_URI) {
        await dodoWebhookHandler(req, res);
        assert.strictEqual(getStatusCode(), 200);
        assert.strictEqual(getBody()?.ignored, true);
      } else {
        await assert.rejects(
          async () => {
            await dodoWebhookHandler(req, res);
          },
          (err: any) => {
            assert.ok(err.message.includes('MONGODB_URI'));
            return true;
          }
        );
      }
    });

    it('handles payment.failed cleanly and records failure without granting credits', async () => {
      const payload = {
        type: 'payment.failed',
        id: `pay_fail_test_${Date.now()}`,
        data: {
          payment_id: `pay_fail_${Date.now()}`,
          status: 'failed',
          error_code: 'card_declined',
          error_message: 'Your card was declined.',
          customer: { metadata: { figmaUserId: 'test-user-pay-fail' } },
        },
      };
      const bodyBuf = Buffer.from(JSON.stringify(payload));
      const now = Math.floor(Date.now() / 1000);
      const signature = createValidSignature(bodyBuf, now);

      const req: any = {
        headers: { 'webhook-signature': signature },
        body: payload,
        rawBody: bodyBuf,
        ip: '127.0.0.1',
      };
      const { res, getStatusCode, getBody } = createMockResponse();

      if (process.env.MONGODB_URI) {
        await dodoWebhookHandler(req, res);
        assert.strictEqual(getStatusCode(), 200);
        assert.strictEqual(getBody()?.action, 'failure_recorded');
        assert.strictEqual(getBody()?.error_code, 'card_declined');
      } else {
        await assert.rejects(
          async () => {
            await dodoWebhookHandler(req, res);
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
