import { runEvals } from '@mastra/core/evals';
import { mastra } from '../mastra';
import { scenarios } from '../data/scenarios';
import { metricGroundingScorer, severityAccuracyScorer } from '../mastra/scorers/insight-scorers';

// Runs every labeled scenario through the workflow and scores the output.
const workflow = mastra.getWorkflow('spendingAlertWorkflow');
type Row = { scenario?: string; expected?: string; got?: string; source?: string; severity: number; grounding: number };
const rows: Row[] = [];

await runEvals({
  target: workflow,
  data: scenarios.map((s) => ({ input: s.input, groundTruth: s.groundTruth })),
  scorers: { workflow: [severityAccuracyScorer, metricGroundingScorer] },
  onItemComplete: ({ item, scorerResults }) => {
    const scenario = scenarios.find((s) => s.input === item.input);
    const scores = (scorerResults as any).workflow ?? {};
    const output = scores['severity-accuracy']?.output;
    rows.push({
      scenario: scenario?.name,
      expected: scenario?.groundTruth.expectedSeverity,
      got: output?.severity,
      source: output?.source,
      severity: scores['severity-accuracy']?.score,
      grounding: scores['metric-grounding']?.score,
    });
  },
});

const avg = (key: 'severity' | 'grounding') => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;

console.table(rows);
console.log(`Scenarios: ${rows.length}`);
console.log(`Severity accuracy: ${(avg('severity') * 100).toFixed(1)}%`);
console.log(`Metric grounding:  ${(avg('grounding') * 100).toFixed(1)}%`);
