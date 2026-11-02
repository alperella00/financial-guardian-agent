import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  buildDeterministicInsight,
  composeInsight,
  computeRunway,
  computeVelocity,
  insightResultSchema,
  insightTextSchema,
  runwayResultSchema,
  safeDailySpend,
  spendingProfileSchema,
  velocityResultSchema,
  type InsightText,
  type SpendingProfile,
  type VelocityResult,
} from '../lib/spending';

const analyzeVelocityStep = createStep({
  id: 'analyze-velocity',
  description: 'Analyzes spending velocity by comparing recent 2-day window against historical average',
  inputSchema: spendingProfileSchema,
  outputSchema: velocityResultSchema,
  execute: async ({ inputData }) => computeVelocity(inputData),
});

const calculateRunwayStep = createStep({
  id: 'calculate-runway',
  description: 'Calculates how many days until budget is depleted and the projected depletion date',
  inputSchema: velocityResultSchema,
  outputSchema: runwayResultSchema,
  execute: async ({ inputData, getInitData }) => {
    const initData = getInitData() as SpendingProfile;
    return computeRunway({
      monthlyBudget: initData.monthlyBudget,
      totalMonthSpend: inputData.totalMonthSpend,
      currentVelocity: inputData.currentVelocity,
      asOf: initData.asOf,
    });
  },
});

const generateInsightStep = createStep({
  id: 'generate-insight',
  description: 'Generates a proactive financial alert with AI-enhanced insight using the financial guardian agent',
  inputSchema: runwayResultSchema,
  outputSchema: insightResultSchema,
  execute: async ({ inputData, getStepResult, getInitData, mastra }) => {
    const runway = inputData;
    const velocity = getStepResult('analyze-velocity') as VelocityResult;
    const initData = getInitData() as SpendingProfile;

    // The verdict (severity + metrics) is decided by the rules first; the LLM only writes the wording
    const rules = buildDeterministicInsight(velocity, runway, initData.monthlyBudget);
    let text: InsightText | undefined;

    const agent = mastra?.getAgent('financialGuardian');

    if (agent) {
      const prompt = `Write the text of a proactive spending alert. The severity is already decided: ${rules.severity.toUpperCase()}.
Use only the figures below; do not invent or recompute other numbers.

User's monthly budget: $${initData.monthlyBudget}
Historical monthly average spending: $${initData.historicalMonthlyAverage}

VELOCITY ANALYSIS:
- Current daily spend rate: $${velocity.currentVelocity}/day
- Historical daily rate: $${velocity.historicalVelocity}/day
- Velocity change: ${velocity.velocityChangePercent}%
- Anomaly detected: ${velocity.isAnomalous}
- Last 2 days spend: $${velocity.recentSpend}

RUNWAY ANALYSIS:
- Remaining budget: $${runway.remainingBudget}
- Daily burn rate: $${runway.dailyBurnRate}/day
- Days until budget depleted: ${runway.daysUntilBudgetDepleted}
- Projected depletion date: ${runway.projectedDepletionDate}
- Days left in month: ${runway.daysLeftInMonth}
- Will exceed budget: ${runway.willExceedBudget}
- Projected month-end spend: $${runway.projectedMonthEndSpend}
- Safe daily spend to stay within budget: $${safeDailySpend(runway).toFixed(2)}/day

Generate a JSON response with:
- title: short alert title matching the ${rules.severity} severity
- message: detailed but concise explanation including the runway date
- recommendations: array of 2-3 actionable suggestions`;

      try {
        const response = await agent.generate([{ role: 'user', content: prompt }], {
          structuredOutput: { schema: insightTextSchema },
          // The metrics are already computed above, so no tool calls are needed here.
          // Gemini also rejects tools combined with structured output in one request.
          toolChoice: 'none',
        });

        text = response.object ?? undefined;
      } catch {
        // Keep the rule-based wording
      }
    }

    return composeInsight(rules, text);
  },
});

const spendingAlertWorkflow = createWorkflow({
  id: 'spending-alert-workflow',
  inputSchema: spendingProfileSchema,
  outputSchema: insightResultSchema,
})
  .then(analyzeVelocityStep)
  .then(calculateRunwayStep)
  .then(generateInsightStep);

spendingAlertWorkflow.commit();

export { spendingAlertWorkflow };
