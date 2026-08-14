// ─── __tests__/plan.lifecycle.test.ts ─────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TRIAL_CREDITS, PLAN_CONFIG, TOPUP_PACKS } from '../config/constants';

describe('Plan Configuration & Limits Invariants', () => {
  it('free trial credits is finite and within safe bounds [0, 50]', () => {
    assert.strictEqual(Number.isFinite(FREE_TRIAL_CREDITS), true);
    assert.ok(FREE_TRIAL_CREDITS >= 0 && FREE_TRIAL_CREDITS <= 50);
  });

  it('pro plan grants exactly 100 credits for 30 days', () => {
    assert.strictEqual(PLAN_CONFIG.pro.credits, 100);
    assert.strictEqual(PLAN_CONFIG.pro.durationDays, 30);
  });

  it('all topup packs have positive credit amounts', () => {
    assert.strictEqual(TOPUP_PACKS.small.credits, 20);
    assert.strictEqual(TOPUP_PACKS.medium.credits, 50);
    assert.strictEqual(TOPUP_PACKS.large.credits, 100);
  });
});
