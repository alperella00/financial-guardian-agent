import { createScorer } from '@mastra/core/evals';
import { analyzeProfile, type InsightResult, type Severity, type SpendingProfile } from '../lib/spending';

// Code-based scorers (no LLM judge) for the spending-alert workflow output.
// They work the same whether the insight came from the LLM or the rule-based fallback.

export type InsightGroundTruth = { expectedSeverity: Severity };

// Does the alert level match the labeled expectation for the scenario?
export const severityAccuracyScorer = createScorer<SpendingProfile, InsightResult>({
  id: 'severity-accuracy',
  name: 'Severity Accuracy',
  description: 'Checks that the alert severity matches the labeled expected severity for the scenario',
}).generateScore(({ run }) => {
  const expected = (run.groundTruth as InsightGroundTruth | undefined)?.expectedSeverity;
  if (!expected) return 1;
  return run.output.severity === expected ? 1 : 0;
});

const MONEY_TOLERANCE = 1; // dollars
const PERCENT_TOLERANCE = 1; // percentage points

// Are the numbers in the alert the ones the deterministic tools computed (no hallucinated figures)?
export const metricGroundingScorer = createScorer<SpendingProfile, InsightResult>({
  id: 'metric-grounding',
  name: 'Metric Grounding',
  description: 'Fraction of reported metrics that match the deterministically computed values',
})
  .analyze(({ run }) => {
    if (!run.input) throw new Error('metric-grounding needs the workflow input to recompute the metrics');
    const { runway, velocity } = analyzeProfile(run.input);
    const m = run.output.metrics;
    return {
      remainingBudget: Math.abs(m.remainingBudget - runway.remainingBudget) <= MONEY_TOLERANCE,
      dailyBurnRate: Math.abs(m.dailyBurnRate - runway.dailyBurnRate) <= MONEY_TOLERANCE,
      projectedDepletionDate: m.projectedDepletionDate === runway.projectedDepletionDate,
      velocityChangePercent: Math.abs(m.velocityChangePercent - velocity.velocityChangePercent) <= PERCENT_TOLERANCE,
    };
  })
  .generateScore(({ results }) => {
    const checks = Object.values(results.analyzeStepResult);
    return checks.filter(Boolean).length / checks.length;
  })
  .generateReason(({ results, score }) => {
    const failed = Object.entries(results.analyzeStepResult)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    return failed.length === 0 ? `All metrics grounded (score ${score})` : `Mismatched metrics: ${failed.join(', ')}`;
  });

export const insightScorers = { severityAccuracyScorer, metricGroundingScorer };
