// ─── __tests__/auth.security.test.ts ──────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken, hashClientSecret } from '../modules/auth/auth.service';
import { authMiddleware } from '../middleware/auth.middleware';

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

describe('Zero-Trust Authentication & Anti-Sybil Security Suite', () => {
  describe('Session JWT Generation & Verification Invariants', () => {
    it('generates a valid signed token for a figmaUserId', () => {
      const figmaUserId = 'user_test_999';
      const token = createSessionToken(figmaUserId);
      assert.ok(typeof token === 'string' && token.split('.').length === 3);

      const verified = verifySessionToken(token);
      assert.strictEqual(verified.figmaUserId, figmaUserId);
    });

    it('rejects tampered token signature', () => {
      const token = createSessionToken('user_test_999');
      const parts = token.split('.');
      // Tamper with payload
      const tamperedPayload = Buffer.from(JSON.stringify({ figmaUserId: 'user_attacker' })).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      assert.throws(
        () => verifySessionToken(tamperedToken),
        (err: any) => err.errorCode === 'invalid_token'
      );
    });

    it('rejects completely random or empty tokens', () => {
      assert.throws(
        () => verifySessionToken(''),
        (err: any) => err.errorCode === 'missing_token'
      );
      assert.throws(
        () => verifySessionToken('random_garbage_string'),
        (err: any) => err.errorCode === 'invalid_token'
      );
    });

    it('client secret hashing is deterministic and irreversible', () => {
      const secret = 'my_super_secret_device_passcode_123';
      const hash1 = hashClientSecret(secret);
      const hash2 = hashClientSecret(secret);
      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash1.length, 64); // SHA-256 hex length
    });
  });

  describe('auth.middleware Security Guards', () => {
    it('blocks unauthenticated requests missing Authorization header (Fixes Exploit #1)', async () => {
      const req: any = {
        headers: {
          'x-figma-user-id': '1594390275759151173', // Pro victim user ID
        },
      };
      const { res, getStatusCode, getBody } = createMockResponse();

      let nextCalled = false;
      await authMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false, 'Unauthenticated request must be blocked');
      assert.strictEqual(getStatusCode(), 401);
      assert.strictEqual(getBody().error, 'missing_token');
    });

    it('blocks identity mismatch when token figmaUserId does not match claimed x-figma-user-id', async () => {
      const attackerToken = createSessionToken('attacker_user_666');
      const req: any = {
        headers: {
          authorization: `Bearer ${attackerToken}`,
          'x-figma-user-id': '1594390275759151173', // Victim user ID
        },
      };
      const { res, getStatusCode, getBody } = createMockResponse();

      let nextCalled = false;
      await authMiddleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false, 'Identity spoofing must be blocked');
      assert.strictEqual(getStatusCode(), 401);
      assert.strictEqual(getBody().error, 'identity_mismatch');
    });
  });
});
