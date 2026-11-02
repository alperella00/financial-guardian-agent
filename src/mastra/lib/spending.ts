import { z } from 'zod';

// Deterministic spending math shared by the agent tools, the workflow steps and the scorers.
// All dates are handled as UTC calendar days ("YYYY-MM-DD") so results do not depend on the host timezone.

export const RECENT_WINDOW_DAYS = 2;
export const ANOMALY_THRESHOLD_PERCENT = 20;
export const CRITICAL_RUNWAY_DAYS = 5;

// A real calendar day in YYYY-MM-DD form (rejects 31/10/2026, empty strings and 2026-02-30)
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
  }, 'Not a valid calendar date');

export const transactionSchema = z.object({
  amount: z.number(),
  category: z.string(),
  date: isoDateSchema.describe('Transaction date, YYYY-MM-DD'),
  description: z.string().optional(),
});

export const spendingProfileSchema = z.object({
  userId: z.string(),
  monthlyBudget: z.number(),
  transactions: z.array(transactionSchema),
  historicalMonthlyAverage: z.number(),
  asOf: isoDateSchema.optional().describe('Evaluation date, YYYY-MM-DD. Defaults to today.'),
});

export const velocityResultSchema = z.object({
  currentVelocity: z.number().describe('Daily spending rate for the recent window (last 2 days)'),
  historicalVelocity: z.number().describe('Average daily spending rate from history'),
  velocityChangePercent: z.number().describe('Percentage change between current and historical velocity'),
  isAnomalous: z.boolean().describe('True if velocity change exceeds the threshold'),
  recentWindowDays: z.number(),
  recentSpend: z.number(),
  totalMonthSpend: z.number(),
  dayOfMonth: z.number(),
});

export const runwayInputSchema = z.object({
  monthlyBudget: z.number(),
  totalMonthSpend: z.number(),
  currentVelocity: z.number().describe('Current daily spending rate'),
  asOf: isoDateSchema.optional().describe('Evaluation date, YYYY-MM-DD. Defaults to today.'),
});

export const runwayResultSchema = z.object({
  remainingBudget: z.number(),
  dailyBurnRate: z.number(),
  daysUntilBudgetDepleted: z.number(),
  projectedDepletionDate: z.string(),
  daysLeftInMonth: z.number(),
  willExceedBudget: z.boolean(),
  projectedMonthEndSpend: z.number(),
  budgetUtilizationPercent: z.number(),
});

export const severitySchema = z.enum(['info', 'warning', 'critical']);

// The only part the LLM writes (structured output). Severity and metrics always come from the rules.
export const insightTextSchema = z.object({
  title: z.string(),
  message: z.string(),
  recommendations: z.array(z.string()),
});

export const insightSchema = insightTextSchema.extend({
  severity: severitySchema,
  metrics: z.object({
    velocityChangePercent: z.number(),
    projectedDepletionDate: z.string(),
    remainingBudget: z.number(),
    dailyBurnRate: z.number(),
  }),
});

// Workflow output: the insight plus who wrote the text. Severity and metrics are always rule-based.
export const insightResultSchema = insightSchema.extend({
  source: z.enum(['llm', 'rules']).describe('Who wrote title/message/recommendations: llm = the agent, rules = deterministic fallback'),
});

export type Transaction = z.infer<typeof transactionSchema>;
export type SpendingProfile = z.infer<typeof spendingProfileSchema>;
export type VelocityResult = z.infer<typeof velocityResultSchema>;
export type RunwayResult = z.infer<typeof runwayResultSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type InsightText = z.infer<typeof insightTextSchema>;
export type Insight = z.infer<typeof insightSchema>;
export type InsightResult = z.infer<typeof insightResultSchema>;

const round2 = (n: number) => Math.round(n * 100) / 100;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDay(date: string): string {
  return date.slice(0, 10);
}

function parseDay(day: string): Date {
  return new Date(`${toDay(day)}T00:00:00Z`);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return formatDay(new Date(parseDay(day).getTime() + days * DAY_MS));
}

export function resolveAsOf(asOf?: string): string {
  return asOf ? toDay(asOf) : formatDay(new Date());
}

export function computeVelocity(profile: SpendingProfile): VelocityResult {
  const asOf = resolveAsOf(profile.asOf);
  const monthStart = `${asOf.slice(0, 7)}-01`;
  // Recent window = the last RECENT_WINDOW_DAYS calendar days, including asOf
  const recentStart = addDays(asOf, -(RECENT_WINDOW_DAYS - 1));

  let totalMonthSpend = 0;
  let recentSpend = 0;
  for (const t of profile.transactions) {
    const day = toDay(t.date);
    if (day > asOf) continue;
    if (day >= monthStart) totalMonthSpend += t.amount;
    if (day >= recentStart) recentSpend += t.amount;
  }

  const currentVelocity = recentSpend / RECENT_WINDOW_DAYS;
  const historicalVelocity = profile.historicalMonthlyAverage / 30;
  const velocityChangePercent = historicalVelocity > 0
    ? ((currentVelocity - historicalVelocity) / historicalVelocity) * 100
    : 0;

  return {
    currentVelocity: round2(currentVelocity),
    historicalVelocity: round2(historicalVelocity),
    velocityChangePercent: round2(velocityChangePercent),
    isAnomalous: velocityChangePercent > ANOMALY_THRESHOLD_PERCENT,
    recentWindowDays: RECENT_WINDOW_DAYS,
    recentSpend: round2(recentSpend),
    totalMonthSpend: round2(totalMonthSpend),
    dayOfMonth: parseDay(asOf).getUTCDate(),
  };
}

export function computeRunway(input: z.infer<typeof runwayInputSchema>): RunwayResult {
  const { monthlyBudget, totalMonthSpend, currentVelocity } = input;
  const asOf = resolveAsOf(input.asOf);
  const asOfDate = parseDay(asOf);

  const remainingBudget = monthlyBudget - totalMonthSpend;
  const lastDayOfMonth = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeftInMonth = lastDayOfMonth - asOfDate.getUTCDate();

  const daysUntilBudgetDepleted = currentVelocity > 0
    ? Math.max(0, Math.floor(remainingBudget / currentVelocity))
    : daysLeftInMonth;

  const projectedMonthEndSpend = totalMonthSpend + currentVelocity * daysLeftInMonth;
  const budgetUtilizationPercent = monthlyBudget > 0 ? (totalMonthSpend / monthlyBudget) * 100 : 0;

  return {
    remainingBudget: round2(remainingBudget),
    dailyBurnRate: round2(currentVelocity),
    daysUntilBudgetDepleted,
    projectedDepletionDate: addDays(asOf, daysUntilBudgetDepleted),
    daysLeftInMonth,
    willExceedBudget: projectedMonthEndSpend > monthlyBudget,
    projectedMonthEndSpend: round2(projectedMonthEndSpend),
    budgetUtilizationPercent: round2(budgetUtilizationPercent),
  };
}

export function classifySeverity(velocity: Pick<VelocityResult, 'isAnomalous'>, runway: RunwayResult): Severity {
  if (runway.remainingBudget <= 0) return 'critical';
  if (runway.willExceedBudget && runway.daysUntilBudgetDepleted <= CRITICAL_RUNWAY_DAYS) return 'critical';
  if (velocity.isAnomalous) return 'warning';
  return 'info';
}

// Rule-based insight: used by the insight tool and as the workflow fallback when the LLM is unavailable
// Daily amount that keeps the month within budget; never negative (once over budget, the answer is $0/day)
export function safeDailySpend(runway: RunwayResult): number {
  return Math.max(0, runway.remainingBudget / Math.max(runway.daysLeftInMonth, 1));
}

export function buildDeterministicInsight(
  velocity: Pick<VelocityResult, 'isAnomalous' | 'velocityChangePercent'>,
  runway: RunwayResult,
  monthlyBudget: number,
): Insight {
  const severity = classifySeverity(velocity, runway);
  const safeDaily = safeDailySpend(runway);
  let title: string;
  let message: string;
  let recommendations: string[];

  if (runway.remainingBudget <= 0) {
    title = 'Budget Depleted';
    message = `Your monthly budget is already exceeded. You've spent ${runway.budgetUtilizationPercent.toFixed(0)}% of your budget.`;
    recommendations = [
      'Immediately freeze non-essential spending',
      'Review and cancel any upcoming subscriptions',
      'Consider transferring funds from savings if available',
    ];
  } else if (severity === 'critical') {
    title = 'Budget Running Out Fast';
    message = `At $${runway.dailyBurnRate.toFixed(0)}/day, your budget will be depleted by ${runway.projectedDepletionDate} -- ${runway.daysUntilBudgetDepleted} days from now. You still have ${runway.daysLeftInMonth} days left in the month.`;
    recommendations = [
      `Reduce daily spending to $${safeDaily.toFixed(0)}/day to make it through the month`,
      'Postpone any planned large purchases',
      'Switch to cash-only for the rest of the week',
    ];
  } else if (velocity.isAnomalous && runway.willExceedBudget) {
    title = 'Spending Acceleration Detected';
    message = `Your spending velocity increased ${velocity.velocityChangePercent.toFixed(0)}% in the last 2 days. Projected month-end spend: $${runway.projectedMonthEndSpend.toFixed(0)} (budget: $${monthlyBudget.toFixed(0)}). Depletion date: ${runway.projectedDepletionDate}.`;
    recommendations = [
      `Aim for $${safeDaily.toFixed(0)}/day to stay within budget`,
      'Review your last 2 days of transactions for unusual purchases',
      'Set a daily spending limit alert on your primary payment method',
    ];
  } else if (velocity.isAnomalous) {
    title = 'Spending Spike Noticed';
    message = `Your recent spending rate is ${velocity.velocityChangePercent.toFixed(0)}% higher than usual. You have $${runway.remainingBudget.toFixed(0)} remaining with ${runway.daysLeftInMonth} days left.`;
    recommendations = [
      'Monitor your spending over the next few days',
      'Check if recent purchases were planned or impulsive',
    ];
  } else {
    title = 'Spending On Track';
    message = `Your spending is within normal range. $${runway.remainingBudget.toFixed(0)} left with ${runway.daysLeftInMonth} days remaining ($${safeDaily.toFixed(0)}/day available).`;
    recommendations = [
      'Keep up the good spending habits',
      'Consider saving the surplus if you stay under budget',
    ];
  }

  return {
    severity,
    title,
    message,
    recommendations,
    metrics: {
      velocityChangePercent: velocity.velocityChangePercent,
      projectedDepletionDate: runway.projectedDepletionDate,
      remainingBudget: runway.remainingBudget,
      dailyBurnRate: runway.dailyBurnRate,
    },
  };
}

// Full deterministic pipeline for a profile; used as ground truth by the scorers
export function analyzeProfile(profile: SpendingProfile) {
  const velocity = computeVelocity(profile);
  const runway = computeRunway({
    monthlyBudget: profile.monthlyBudget,
    totalMonthSpend: velocity.totalMonthSpend,
    currentVelocity: velocity.currentVelocity,
    asOf: profile.asOf,
  });
  return { velocity, runway, insight: buildDeterministicInsight(velocity, runway, profile.monthlyBudget) };
}

// The rules decide severity and metrics; the LLM can only contribute wording.
export function composeInsight(rules: Insight, text: InsightText | undefined): InsightResult {
  if (!text) return { ...rules, source: 'rules' };
  return {
    ...rules,
    title: text.title,
    message: text.message,
    recommendations: text.recommendations,
    source: 'llm',
  };
}

// Dollar amounts and percentages that can legitimately appear in an alert's text for this profile.
// Used by the text-grounding scorer to spot figures that are not derived from the data.
export function referenceFigures(profile: SpendingProfile): { dollars: number[]; percents: number[] } {
  const { velocity, runway } = analyzeProfile(profile);
  const dollars = [
    profile.monthlyBudget,
    profile.historicalMonthlyAverage,
    velocity.currentVelocity,
    velocity.historicalVelocity,
    velocity.recentSpend,
    velocity.totalMonthSpend,
    runway.remainingBudget,
    runway.dailyBurnRate,
    runway.projectedMonthEndSpend,
    safeDailySpend(runway),
    Math.abs(profile.monthlyBudget - runway.projectedMonthEndSpend), // projected surplus or overrun
    Math.abs(runway.remainingBudget), // amount already over budget, when depleted
  ];
  const percents = [
    velocity.velocityChangePercent,
    runway.budgetUtilizationPercent,
    ANOMALY_THRESHOLD_PERCENT,
  ];
  return { dollars, percents };
}
