// ─── __tests__/credits.atomic.test.ts ─────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CREDIT_COST, DEFAULT_MODEL, DEFAULT_MODEL_KEY, MODEL_MAP } from '../config/constants';
import { resolveModel } from '../modules/ai/ai.router';

describe('Credit Cost & Model Routing Invariants', () => {
  it('free plan users are always routed to DEFAULT_MODEL (1 credit)', () => {
    // Even if free user requested gpt-4o (4 credits)
    const rawModel = MODEL_MAP['gpt-4o'];
    const routedModel = resolveModel(rawModel, 4, 'free');

    assert.strictEqual(routedModel, DEFAULT_MODEL, 'Free user must be routed to DEFAULT_MODEL');
  });

  it('pro plan users retain requested model without downgrade', () => {
    const rawModel = MODEL_MAP['deepseek-v4-pro'];
    const routedModel = resolveModel(rawModel, 1, 'pro');

    assert.strictEqual(routedModel, rawModel, 'Pro user must keep their selected premium model');
  });

  it('all model keys in MODEL_MAP have corresponding credit costs', () => {
    for (const key of Object.keys(MODEL_MAP)) {
      const cost = MODEL_CREDIT_COST[key];
      assert.ok(typeof cost === 'number' && cost >= 1, `Model ${key} must have a valid credit cost >= 1`);
    }
  });

  it('default model key matches default model OpenRouter identifier', () => {
    assert.strictEqual(MODEL_MAP[DEFAULT_MODEL_KEY], DEFAULT_MODEL);
  });
});
