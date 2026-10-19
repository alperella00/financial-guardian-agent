# Financial Guardian Agent

A proactive personal-finance AI agent built with [Mastra](https://mastra.ai/) and TypeScript. It watches spending, spots sudden jumps in how fast money is going out, projects the date the monthly budget runs out, and sends a specific alert before that happens.

> "Your spending velocity increased 70% in the last 2 days. Projected month-end spend: $3470 (budget: $3000). Depletion date: 2026-03-28. Aim for $127/day to stay within budget."

## How it works

```
spending profile ──► analyze-velocity ──► calculate-runway ──► generate-insight ──► alert
(budget, history,     last 2 days vs        days until budget     LLM (structured        severity, message,
 transactions)        historical daily      runs out, month-end   output) with rule-     recommendations,
                      rate, anomaly flag    projection            based fallback         metrics, source
```

- **Agent:** `Financial Guardian`, a Mastra `Agent` running on Claude Sonnet 4.5 (through OpenRouter), with memory and three tools:
  - `analyzeSpendingVelocity`: compares the recent daily spend rate with the historical one and flags a jump of more than 20% as an anomaly.
  - `calculateRunway`: computes how many days the remaining budget lasts, the projected depletion date and the month-end spend.
  - `generateFinancialInsight`: produces a rule-based alert with a severity level.
- **Workflow:** `spending-alert-workflow`, a typed three-step Mastra workflow. The last step asks the agent for a Zod-validated **structured output**. If the LLM call fails or returns nothing valid, it **falls back to deterministic rules** that produce the same output shape. Every alert carries a `source` field (`llm` or `rules`).
- **Observability:** LibSQL storage, Pino logging and Mastra tracing, with `SensitiveDataFilter` hiding secrets in traces.

### Design decisions

- **The numbers come from code, not the LLM.** Velocity, runway and dates are computed deterministically in `src/mastra/lib/spending.ts`. The LLM only writes the explanation and recommendations, and the metric-grounding scorer checks that it copied the numbers correctly.
- **One source of truth.** The tools, the workflow steps and the scorers all use the same functions in `lib/spending.ts`.
- **Reproducible runs.** Inputs take an optional `asOf` date, and all date math is done on UTC calendar days, so a scenario gives the same result on any machine and any day.

## Getting started

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env   # add your OPENROUTER_API_KEY
```

| Command | What it does |
|---|---|
| `npm run dev` | Opens Mastra Studio at http://localhost:4111 to chat with the agent and run the workflow |
| `npm run example -- <scenario>` | Runs the workflow on one labeled scenario and prints the alert |
| `npm run eval` | Runs every scenario through the workflow and scores the results |
| `npm run typecheck` | TypeScript type check |

Without an API key, the workflow still runs: the LLM step fails and the rule-based fallback produces the alert (`"source": "rules"`).

### Example output

`npm run example -- acceleration-over-budget` (run without an API key, so the fallback path is used):

```json
{
  "severity": "warning",
  "title": "Spending Acceleration Detected",
  "message": "Your spending velocity increased 70% in the last 2 days. Projected month-end spend: $3470 (budget: $3000). Depletion date: 2026-03-28.",
  "recommendations": [
    "Aim for $127/day to stay within budget",
    "Review your last 2 days of transactions for unusual purchases",
    "Set a daily spending limit alert on your primary payment method"
  ],
  "metrics": {
    "velocityChangePercent": 70,
    "projectedDepletionDate": "2026-03-28",
    "remainingBudget": 1400,
    "dailyBurnRate": 170
  },
  "source": "rules"
}
```

## Evaluation

`src/data/scenarios.ts` holds six labeled scenarios: on track, a spike that stays within budget, a spike that leads to an overrun, about one day of budget left, budget already exceeded, and the last day of the month. Two code-based Mastra scorers (no LLM judge) score each workflow output:

- **Severity accuracy:** does the alert level match the scenario's labeled severity?
- **Metric grounding:** what fraction of the reported metrics match the values the deterministic code computes? This catches numbers the LLM made up or copied wrong.

Latest `npm run eval`:

| scenario | expected | got | source | severity | grounding |
|---|---|---|---|---|---|
| on-track | info | info | rules | 1 | 1 |
| spike-within-budget | warning | warning | rules | 1 | 1 |
| acceleration-over-budget | warning | warning | rules | 1 | 1 |
| runway-critical | critical | critical | rules | 1 | 1 |
| budget-depleted | critical | critical | rules | 1 | 1 |
| last-day-of-month | info | info | rules | 1 | 1 |

**How to read this:** this run had no API key, so every alert came from the rule-based fallback. Severity accuracy here checks the rules against the labels. Metric grounding is 100% by construction on this path, because the rules use the same functions as the scorer. Running `npm run eval` with an `OPENROUTER_API_KEY` scores the LLM-generated alerts (`source: llm`), which is the case these scorers are meant for.

## Project structure

```
src/
├── mastra/
│   ├── index.ts                         # Mastra instance: agent, workflow, scorers, storage, tracing
│   ├── agents/financial-guardian.ts     # Agent definition and instructions
│   ├── tools/spending-tools.ts          # Agent tools (thin wrappers over lib/spending)
│   ├── workflows/spending-alert-workflow.ts
│   ├── scorers/insight-scorers.ts       # Severity accuracy and metric grounding
│   └── lib/spending.ts                  # Deterministic spending math and Zod schemas
├── data/scenarios.ts                    # Labeled evaluation scenarios
└── scripts/
    ├── run-example.ts
    └── eval.ts
```

## Limitations

- No bank or Open Banking integration: transactions are passed in as input.
- No end-user UI: the agent is used through Mastra Studio or its REST API.
- The scenarios are synthetic, and the historical baseline is a single monthly average.
