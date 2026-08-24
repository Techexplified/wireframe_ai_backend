// ─── __tests__/credit.refund.test.ts ─────────────────────────────────────────
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostUSD } from '../modules/ai/ai.telemetry';

describe('Credit & Telemetry Cost Formula Invariants', () => {
  it('computeCostUSD includes reasoning tokens at output token pricing', () => {
    const model = 'openai/gpt-4o'; // input: $2.50/1M, output: $10.00/1M
    const promptTokens = 1000;
    const completionTokens = 2000;
    const reasoningTokens = 1000;

    const costWithReasoning = computeCostUSD(model, promptTokens, completionTokens, reasoningTokens);
    const costWithoutReasoning = computeCostUSD(model, promptTokens, completionTokens, 0);

    // 1000 reasoning tokens at $10/1M = $0.010
    const expectedDifference = (1000 / 1_000_000) * 10;

    assert.ok(costWithReasoning > costWithoutReasoning, 'Reasoning tokens must increase cost');
    assert.strictEqual(
      Math.abs((costWithReasoning - costWithoutReasoning) - expectedDifference) < 1e-9,
      true,
      'Reasoning tokens must be billed at output rate'
    );
  });

  it('computeCostUSD handles 0 reasoning tokens properly as default', () => {
    const model = 'openai/gpt-5.6-luna';
    const cost = computeCostUSD(model, 1000, 1000);
    assert.ok(typeof cost === 'number' && cost > 0);
  });
});
