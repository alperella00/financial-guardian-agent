# Financial Guardian Agent

A proactive personal-finance AI agent built with [Mastra](https://mastra.ai/) and TypeScript. It works with any model Mastra supports (tested with Claude via OpenRouter and Gemini 3.5 Flash). It watches spending, spots sudden jumps in how fast money is going out, projects the date the monthly budget runs out, and sends a specific alert before that happens.

> "Your spending velocity increased 70% in the last 2 days. Projected month-end spend: $3470 (budget: $3000). Depletion date: 2026-03-28. Aim for $127/day to stay within budget."

## How it works

```
spending profile ──► analyze-velocity ──► calculate-runway ──► generate-insight ──► alert
(budget, history,     last 2 days vs        days until budget     LLM (structured        severity, message,
 transactions)        historical daily      runs out, month-end   output) with rule-     recommendations,
                      rate, anomaly flag    projection            based fallback         metrics, source
```

- **Agent:** `Financial Guardian`, a Mastra `Agent` with memory and three tools. Its model is set by `GUARDIAN_MODEL` (default: Claude Sonnet 4.5 through OpenRouter).
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
cp .env.example .env   # add OPENROUTER_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY + GUARDIAN_MODEL=google/gemini-3.5-flash
```

| Command | What it does |
|---|---|
| `npm run dev` | Opens Mastra Studio at http://localhost:4111 to chat with the agent and run the workflow |
| `npm run example -- <scenario>` | Runs the workflow on one labeled scenario and prints the alert |
| `npm run eval` | Runs every scenario through the workflow and scores the results |
| `npm run typecheck` | TypeScript type check |

Without an API key, the workflow still runs: the LLM step fails and the rule-based fallback produces the alert (`"source": "rules"`).

### Example output

`npm run example -- spike-within-budget` with `GUARDIAN_MODEL=google/gemini-3.5-flash`:

```json
{
  "severity": "warning",
  "title": "Spending Velocity Spike Detected",
  "message": "Your spending speed has accelerated by 30% over the last 2 days, rising to $130/day from your baseline of $100/day. With $1,840 remaining for the final 11 days of the month, your budget runway extends to 2026-04-03. You are still on track to finish under budget, but continuing this burn rate reduces your safety cushion.",
  "recommendations": [
    "Cap daily discretionary spending at $167/day or less to comfortably finish the month within budget.",
    "Review the $260 spent over the last 2 days to check for one-time or recurring unplanned expenses.",
    "Aim to return to your baseline daily burn rate of $100/day for the remaining 11 days to keep an extra $410 buffer."
  ],
  "metrics": {
    "velocityChangePercent": 30,
    "projectedDepletionDate": "2026-04-03",
    "remainingBudget": 1840,
    "dailyBurnRate": 130
  },
  "source": "llm"
}
```

The `metrics` match the computed values exactly, but the last recommendation has an arithmetic slip: at $100/day the buffer would be $740. $410 is the buffer at the current $130/day. See [Limitations](#limitations).

## Evaluation

`src/data/scenarios.ts` holds six labeled scenarios: on track, a spike that stays within budget, a spike that leads to an overrun, about one day of budget left, budget already exceeded, and the last day of the month. Two code-based Mastra scorers (no LLM judge) score each workflow output:

- **Severity accuracy:** does the alert level match the scenario's labeled severity?
- **Metric grounding:** what fraction of the reported metrics match the values the deterministic code computes? This catches numbers the LLM made up or copied wrong.

Results from two `npm run eval` runs with Gemini 3.5 Flash (free tier):

| scenario | expected | run 1 | run 2 |
|---|---|---|---|
| on-track | info | info (rules) | info (**llm**) |
| spike-within-budget | warning | warning (**llm**) | warning (**llm**) |
| acceleration-over-budget | warning | warning (rules) | warning (rules) |
| runway-critical | critical | critical (rules) | critical (**llm**) |
| budget-depleted | critical | critical (**llm**) | critical (rules) |
| last-day-of-month | info | info (**llm**) | info (rules) |

- **LLM-generated alerts:** 6 of 12 runs, covering 5 of the 6 scenarios. All 6 had the correct severity and metric grounding of 1.0.
- **Rule-based fallback:** the other 6 runs, where the free-tier API returned `503 high demand`. The workflow still produced a valid, correct alert each time.
- `npm run eval` reports LLM-generated and fallback outputs separately, because fallback outputs match the scorers by construction.

This is a small, synthetic test set: it shows the pipeline and the scorers work, not that the agent is production-ready.

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
- Metric grounding checks only the structured `metrics` field. Numbers inside the free-text message and recommendations are not verified yet (see the example output above). Next step: extract the figures from the text and check them against the computed values.
- With Gemini, tool calls are turned off in the workflow's LLM step (`toolChoice: 'none'`), because Gemini rejects tools and structured output in the same request. The step does not need tools anyway: the metrics are computed before it runs.
