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

const pct = (subset: Row[], key: 'severity' | 'grounding') =>
  subset.length ? `${((subset.reduce((sum, r) => sum + r[key], 0) / subset.length) * 100).toFixed(1)}%` : 'n/a';

// Rule-based outputs match the scorers by construction, so report LLM-generated outputs separately
const llmRows = rows.filter((r) => r.source === 'llm');

console.table(rows);
console.log(`Scenarios: ${rows.length} (LLM-generated: ${llmRows.length}, rule-based fallback: ${rows.length - llmRows.length})`);
console.log(`All outputs   -> severity accuracy ${pct(rows, 'severity')}, metric grounding ${pct(rows, 'grounding')}`);
console.log(`LLM outputs   -> severity accuracy ${pct(llmRows, 'severity')}, metric grounding ${pct(llmRows, 'grounding')}`);
