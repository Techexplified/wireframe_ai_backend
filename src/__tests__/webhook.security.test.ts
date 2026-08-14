// ─── __tests__/webhook.security.test.ts ───────────────────────────────────────
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { verifyWebhookSignature } from '../modules/payments/providers/dodo.provider';

describe('Webhook Signature & Security Verification', () => {
  const secret = 'whsec_test_secret_1234567890';
  const originalSecret = process.env.DODO_WEBHOOK_SECRET;

  before(() => {
    process.env.DODO_WEBHOOK_SECRET = secret;
  });

  after(() => {
    process.env.DODO_WEBHOOK_SECRET = originalSecret;
  });

  function createValidSignatureHeader(body: Buffer, timestamp: number): string {
    const signedPayload = `${timestamp}.${body.toString('utf8')}`;
    const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return `t=${timestamp},v1=${sig}`;
  }

  it('should accept valid signature with recent timestamp', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.succeeded', id: 'pay_123' }));
    const now = Math.floor(Date.now() / 1000);
    const header = createValidSignatureHeader(body, now);

    const isValid = verifyWebhookSignature(body, header);
    assert.strictEqual(isValid, true, 'Valid signature must pass verification');
  });

  it('should reject signature with expired timestamp (> 300s old)', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.succeeded', id: 'pay_old' }));
    const oldTimestamp = Math.floor(Date.now() / 1000) - 350; // 350s old
    const header = createValidSignatureHeader(body, oldTimestamp);

    const isValid = verifyWebhookSignature(body, header);
    assert.strictEqual(isValid, false, 'Expired timestamp must be rejected to prevent replay');
  });

  it('should reject tampered payload', () => {
    const originalBody = Buffer.from(JSON.stringify({ event: 'payment.succeeded', credits: 10 }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'payment.succeeded', credits: 1000 }));
    const now = Math.floor(Date.now() / 1000);
    const header = createValidSignatureHeader(originalBody, now);

    const isValid = verifyWebhookSignature(tamperedBody, header);
    assert.strictEqual(isValid, false, 'Tampered payload must fail signature verification');
  });

  it('should fail closed when secret is empty', () => {
    process.env.DODO_WEBHOOK_SECRET = '';
    const body = Buffer.from(JSON.stringify({ event: 'payment.succeeded' }));
    const header = 't=123456,v1=abcdef';

    const isValid = verifyWebhookSignature(body, header);
    assert.strictEqual(isValid, false, 'Empty webhook secret must fail closed');
    process.env.DODO_WEBHOOK_SECRET = secret;
  });
});
