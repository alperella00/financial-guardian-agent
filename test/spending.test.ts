import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mastra } from '../src/mastra';
import { scenarios } from '../src/data/scenarios';
import {
  analyzeProfile,
  composeInsight,
  referenceFigures,
  safeDailySpend,
  spendingProfileSchema,
  type InsightText,
} from '../src/mastra/lib/spending';
import { extractFigures, isSupported } from '../src/mastra/scorers/insight-scorers';

const profile = (overrides: Record<string, unknown> = {}) => ({
  userId: 'u',
  monthlyBudget: 3000,
  historicalMonthlyAverage: 3000,
  asOf: '2026-03-20',
  transactions: [{ amount: 500, category: 'shopping', date: '2026-03-19' }],
  ...overrides,
});

test('dates must be real YYYY-MM-DD calendar days', () => {
  for (const asOf of ['31/10/2026', '', '2026-02-30', '2026-3-5']) {
    const result = spendingProfileSchema.safeParse(profile({ asOf }));
    assert.equal(result.success, false, `asOf "${asOf}" should be rejected`);
    assert.deepEqual(result.error?.issues[0].path, ['asOf']);
  }
  assert.equal(spendingProfileSchema.safeParse(profile()).success, true);
  assert.equal(spendingProfileSchema.safeParse(profile({ asOf: undefined })).success, true);
});

test('a badly formatted transaction date is rejected instead of silently ignored', () => {
  const bad = profile({ transactions: [{ amount: 500, category: 'shopping', date: '19/03/2026' }] });
  const result = spendingProfileSchema.safeParse(bad);
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0].path, ['transactions', 0, 'date']);
});

test('the workflow rejects an invalid date with a validation error naming the field', async () => {
  const run = await mastra.getWorkflow('spendingAlertWorkflow').createRun();
  await assert.rejects(run.start({ inputData: profile({ asOf: '31/10/2026' }) }), (err: Error) => {
    assert.match(err.message, /Invalid input data/);
    assert.match(err.message, /asOf/);
    return true;
  });
});

test('LLM text cannot change the rule-based severity or metrics', () => {
  const critical = scenarios.find((s) => s.name === 'runway-critical')!;
  const rules = analyzeProfile(critical.input).insight;
  // A model that ignores the schema and tries to downgrade the alert
  const llmText = {
    title: 'All good',
    message: 'Nothing to worry about.',
    recommendations: ['Relax'],
    severity: 'info',
    metrics: { remainingBudget: 999999 },
  } as unknown as InsightText;

  const result = composeInsight(rules, llmText);
  assert.equal(result.severity, 'critical');
  assert.deepEqual(result.metrics, rules.metrics);
  assert.equal(result.message, 'Nothing to worry about.');
  assert.equal(result.source, 'llm');
  assert.equal(composeInsight(rules, undefined).source, 'rules');
});

test('text grounding: extracts figures and flags ones not derived from the data', () => {
  const spike = scenarios.find((s) => s.name === 'spike-within-budget')!;
  const refs = referenceFigures(spike.input);
  const found = extractFigures('Up 30% to $130/day. $1,840 left; cap at $167/day. Keep a $999 buffer.');
  assert.deepEqual(found, { dollars: [130, 1840, 167, 999], percents: [30] });
  assert.deepEqual(found.dollars.filter((v) => !isSupported(v, refs.dollars)), [999]);
});

test('text grounding: a decrease written as "15% lower" matches a -15% change', () => {
  const onTrack = scenarios.find((s) => s.name === 'on-track')!;
  assert.equal(analyzeProfile(onTrack.input).velocity.velocityChangePercent, -15);
  assert.equal(isSupported(15, referenceFigures(onTrack.input).percents), true);
});

test('safe daily spend is $0, not negative, once the budget is exceeded', () => {
  const depleted = scenarios.find((s) => s.name === 'budget-depleted')!;
  const { runway } = analyzeProfile(depleted.input);
  assert.ok(runway.remainingBudget < 0);
  assert.equal(safeDailySpend(runway), 0);
  assert.equal(isSupported(0, referenceFigures(depleted.input).dollars), true);
});

test('every labeled scenario gets its expected severity from the rules', () => {
  for (const s of scenarios) {
    assert.equal(analyzeProfile(s.input).insight.severity, s.groundTruth.expectedSeverity, s.name);
  }
});
