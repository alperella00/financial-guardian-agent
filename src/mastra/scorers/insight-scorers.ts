import { createScorer } from '@mastra/core/evals';
import { referenceFigures, type InsightResult, type Severity, type SpendingProfile } from '../lib/spending';

// Code-based scorers (no LLM judge) for the spending-alert workflow output.

export type InsightGroundTruth = { expectedSeverity: Severity };

// Does the alert level match the labeled expectation for the scenario?
// Severity is always rule-based, so this checks the rules against the labels.
export const severityAccuracyScorer = createScorer<SpendingProfile, InsightResult>({
  id: 'severity-accuracy',
  name: 'Severity Accuracy',
  description: 'Checks that the alert severity matches the labeled expected severity for the scenario',
}).generateScore(({ run }) => {
  const expected = (run.groundTruth as InsightGroundTruth | undefined)?.expectedSeverity;
  if (!expected) return 1;
  return run.output.severity === expected ? 1 : 0;
});

// Figures count as supported when they are within $1 / 1 point, or 1% relative, of a reference value.
// Compared by magnitude: text states direction in words ("15% lower"), while the data holds -15.
export function isSupported(value: number, references: number[]): boolean {
  return references.some((ref) => {
    const magnitude = Math.abs(ref);
    return Math.abs(value - magnitude) <= Math.max(1, magnitude * 0.01);
  });
}

export function extractFigures(text: string): { dollars: number[]; percents: number[] } {
  const toNumber = (s: string) => Number(s.replace(/,/g, ''));
  const dollars = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => toNumber(m[1]));
  const percents = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?%/g)].map((m) => toNumber(m[1]));
  return { dollars, percents };
}

// Are the dollar amounts and percentages in the alert text derived from the data?
// Catches invented figures; it cannot tell when a real figure is attached to the wrong claim.
export const textGroundingScorer = createScorer<SpendingProfile, InsightResult>({
  id: 'text-grounding',
  name: 'Text Grounding',
  description: 'Fraction of dollar amounts and percentages in the alert text that match values derived from the data',
})
  .analyze(({ run }) => {
    if (!run.input) throw new Error('text-grounding needs the workflow input to derive the reference figures');
    const refs = referenceFigures(run.input);
    const text = [run.output.title, run.output.message, ...run.output.recommendations].join('\n');
    const found = extractFigures(text);
    const unsupported = [
      ...found.dollars.filter((v) => !isSupported(v, refs.dollars)).map((v) => `$${v}`),
      ...found.percents.filter((v) => !isSupported(v, refs.percents)).map((v) => `${v}%`),
    ];
    return { total: found.dollars.length + found.percents.length, unsupported };
  })
  .generateScore(({ results }) => {
    const { total, unsupported } = results.analyzeStepResult;
    return total === 0 ? 1 : (total - unsupported.length) / total;
  })
  .generateReason(({ results, score }) => {
    const { total, unsupported } = results.analyzeStepResult;
    return unsupported.length === 0
      ? `All ${total} figures grounded (score ${score})`
      : `Unsupported figures: ${unsupported.join(', ')}`;
  });

export const insightScorers = { severityAccuracyScorer, textGroundingScorer };
