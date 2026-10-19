import type { InsightGroundTruth } from '../mastra/scorers/insight-scorers';
import type { SpendingProfile, Transaction } from '../mastra/lib/spending';

// Labeled spending scenarios used by the example runner and the eval suite.
// Every scenario has a fixed asOf date so results are reproducible.

const CATEGORIES = ['groceries', 'dining', 'transport', 'shopping', 'entertainment'];

// One transaction per day: `baseDaily` from the 1st up to two days before asOf, then `lastTwoDays`
function buildMonth(asOf: string, baseDaily: number, lastTwoDays: [number, number]): Transaction[] {
  const [year, month, day] = asOf.split('-').map(Number);
  const tx: Transaction[] = [];
  for (let d = 1; d <= day; d++) {
    const amount = d === day - 1 ? lastTwoDays[0] : d === day ? lastTwoDays[1] : baseDaily;
    tx.push({
      amount,
      category: CATEGORIES[d % CATEGORIES.length],
      date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    });
  }
  return tx;
}

export type Scenario = {
  name: string;
  description: string;
  input: SpendingProfile;
  groundTruth: InsightGroundTruth;
};

const base = { monthlyBudget: 3000, historicalMonthlyAverage: 3000 };

export const scenarios: Scenario[] = [
  {
    name: 'on-track',
    description: 'Steady spending slightly below the usual rate',
    input: {
      ...base,
      userId: 'user-on-track',
      asOf: '2026-03-20',
      transactions: [
        // Previous-month spend must be ignored
        { amount: 900, category: 'rent', date: '2026-02-28' },
        ...buildMonth('2026-03-20', 90, [90, 80]),
      ],
    },
    groundTruth: { expectedSeverity: 'info' },
  },
  {
    name: 'spike-within-budget',
    description: '+30% velocity spike, but the month still ends under budget',
    input: { ...base, userId: 'user-spike', asOf: '2026-03-20', transactions: buildMonth('2026-03-20', 50, [120, 140]) },
    groundTruth: { expectedSeverity: 'warning' },
  },
  {
    name: 'acceleration-over-budget',
    description: '+70% velocity spike that projects a budget overrun',
    input: { ...base, userId: 'user-accel', asOf: '2026-03-20', transactions: buildMonth('2026-03-20', 70, [160, 180]) },
    groundTruth: { expectedSeverity: 'warning' },
  },
  {
    name: 'runway-critical',
    description: 'About one day of budget left at the current rate',
    input: { ...base, userId: 'user-runway', asOf: '2026-03-20', transactions: buildMonth('2026-03-20', 130, [200, 240]) },
    groundTruth: { expectedSeverity: 'critical' },
  },
  {
    name: 'budget-depleted',
    description: 'Budget already exceeded before month end',
    input: { ...base, userId: 'user-depleted', asOf: '2026-03-20', transactions: buildMonth('2026-03-20', 170, [100, 100]) },
    groundTruth: { expectedSeverity: 'critical' },
  },
  {
    name: 'last-day-of-month',
    description: 'Edge case: zero days left in the month',
    input: { ...base, userId: 'user-month-end', asOf: '2026-03-31', transactions: buildMonth('2026-03-31', 95, [60, 60]) },
    groundTruth: { expectedSeverity: 'info' },
  },
];
