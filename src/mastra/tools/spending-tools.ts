import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  buildDeterministicInsight,
  computeRunway,
  computeVelocity,
  insightSchema,
  runwayInputSchema,
  runwayResultSchema,
  spendingProfileSchema,
  velocityResultSchema,
} from '../lib/spending';

export const analyzeSpendingVelocity = createTool({
  id: 'analyze-spending-velocity',
  description: 'Analyzes spending velocity by comparing recent spend rate against historical average. Detects anomalous acceleration in spending patterns.',
  inputSchema: spendingProfileSchema,
  outputSchema: velocityResultSchema,
  execute: async (inputData) => computeVelocity(inputData),
});

export const calculateRunway = createTool({
  id: 'calculate-runway',
  description: 'Calculates financial runway: how many days until budget is depleted at current spending velocity, and the projected depletion date.',
  inputSchema: runwayInputSchema,
  outputSchema: runwayResultSchema,
  execute: async (inputData) => computeRunway(inputData),
});

export const generateFinancialInsight = createTool({
  id: 'generate-financial-insight',
  description: 'Generates a proactive financial insight with severity level and actionable recommendations based on velocity analysis and runway data.',
  inputSchema: z.object({
    velocityChangePercent: z.number(),
    isAnomalous: z.boolean(),
    monthlyBudget: z.number(),
    runway: runwayResultSchema,
  }),
  outputSchema: insightSchema,
  execute: async ({ velocityChangePercent, isAnomalous, monthlyBudget, runway }) =>
    buildDeterministicInsight({ velocityChangePercent, isAnomalous }, runway, monthlyBudget),
});
