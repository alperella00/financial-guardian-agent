# Financial Guardian Agent

A proactive personal-finance AI agent built with [Mastra](https://mastra.ai/) and TypeScript. It works with any model Mastra supports (tested with Claude via OpenRouter and Gemini Flash). It watches spending, spots sudden jumps in how fast money is going out, projects the date the monthly budget runs out, and sends a specific alert before that happens.

> "Your spending velocity increased 70% in the last 2 days. Projected month-end spend: $3470 (budget: $3000). Depletion date: 2026-03-28. Aim for $127/day to stay within budget."

## How it works

```
spending profile ──► analyze-velocity ──► calculate-runway ──► generate-insight ──► alert
(budget, history,     last 2 days vs        days until budget     rules decide the      severity + metrics (rules),
 transactions)        historical daily      runs out, month-end   verdict; LLM writes   title, message and
                      rate, anomaly flag    projection            the wording           recommendations (LLM)
```

- **Agent:** `Financial Guardian`, a Mastra `Agent` with memory and three tools. Its model is set by `GUARDIAN_MODEL` (default: Claude Sonnet 4.5 through OpenRouter).
  - `analyzeSpendingVelocity`: compares the recent daily spend rate with the historical one and flags a jump of more than 20% as an anomaly.
  - `calculateRunway`: computes how many days the remaining budget lasts, the projected depletion date and the month-end spend.
  - `generateFinancialInsight`: produces a rule-based alert with a severity level.
- **Workflow:** `spending-alert-workflow`, a typed three-step Mastra workflow. The last step first builds the rule-based alert, which fixes the **severity and metrics**. It then asks the agent for Zod-validated **structured output** containing only the title, message and recommendations. If the LLM call fails, the rule-based wording is kept. The `source` field says who wrote the text (`llm` or `rules`). The verdict always comes from the rules.
- **Input validation:** dates must be real `YYYY-MM-DD` calendar days. A value like `31/10/2026` is rejected with a validation error that names the field, instead of crashing or being silently ignored.
- **Observability:** LibSQL storage, Pino logging and Mastra tracing, with `SensitiveDataFilter` hiding secrets in traces.

### Design decisions

- **The LLM never decides the verdict.** Velocity, runway, dates and severity are computed deterministically in `src/mastra/lib/spending.ts`. The LLM only writes the explanation and recommendations, and cannot override severity or metrics (`composeInsight`, covered by a test).
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
| `npm test` | Unit tests: date validation, verdict protection, text-grounding helpers, scenario labels |
| `npm run typecheck` | TypeScript type check |

Without an API key, the workflow still runs: the LLM step fails and the rule-based fallback writes the alert (`"source": "rules"`).

> **Before deploying:** the Mastra server has no authentication configured. `npm run dev` only listens on `localhost`, but if you deploy it (`mastra build` / `mastra start`), add [server auth](https://mastra.ai/docs/server/auth) first. Otherwise anyone who can reach it can call the agent with your API key. `CloudExporter` only sends traces when `MASTRA_CLOUD_ACCESS_TOKEN` is set.

### Example output

`npm run example -- spike-within-budget` with Gemini (`source: "llm"`, so the text is LLM-written; severity and metrics come from the rules):

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

The last recommendation has a reasoning slip. $410 is a real figure (the projected surplus at the current $130/day), but at $100/day the buffer would be $740. The text-grounding scorer accepts it because the number itself is derived from the data. See [Limitations](#limitations).

## Evaluation

`src/data/scenarios.ts` holds six labeled scenarios: on track, a spike that stays within budget, a spike that leads to an overrun, about one day of budget left, budget already exceeded, and the last day of the month. Two code-based Mastra scorers (no LLM judge) score each workflow output:

- **Severity accuracy:** does the alert level match the scenario's labeled severity? Severity is always rule-based, so this validates the rules.
- **Text grounding:** what fraction of the dollar amounts and percentages in the title, message and recommendations are derived from the data (within $1, 1 point or 1%)? This catches invented figures in the LLM's wording.

`npm run eval` reports LLM-written and fallback outputs separately, because fallback text is grounded by construction.

### Results and what they found

Two runs with Gemini Flash on the free tier, after the verdict and validation fixes:

| scenario | expected | run 1 | run 2 |
|---|---|---|---|
| on-track | info | info (**llm**) | info (**llm**) |
| spike-within-budget | warning | warning (**llm**) | warning (rules) |
| acceleration-over-budget | warning | warning (**llm**) | warning (**llm**) |
| runway-critical | critical | critical (**llm**) | critical (**llm**) |
| budget-depleted | critical | critical (**llm**), text grounding 0.83 | critical (rules) |
| last-day-of-month | info | info (**llm**) | info (rules) |

- **Severity accuracy:** 100% on all 12 outputs (9 written by the LLM, 3 by the rule-based fallback after free-tier API errors).
- **Text grounding on LLM text:** 97.2% in run 1, 100% in run 2.

Building the eval surfaced three bugs, two of them in this project's own code:

1. **Scorer false positive.** An earlier version flagged "15% lower" as unsupported because the data holds -15%. Figures are now compared by magnitude (regression test added).
2. **Negative "safe daily spend" in the prompt.** In the budget-depleted scenario the prompt passed `$-23.64/day`, and the model wrote "your target safe daily spend rate is -$24/day". Its other answer, "$0/day", was flagged because $0 was not a reference value. The safe daily spend is now clamped at $0 in the prompt, the rule-based text and the scorer (test added). *This fix is covered by unit tests but has not been re-run against the LLM yet: the free-tier daily quota ran out.*
3. **Reasoning slips the scorer cannot see.** See the $410 example above.

This is a small, synthetic test set: it shows the pipeline and the scorers work, not that the agent is production-ready.

## Project structure

```
src/
├── mastra/
│   ├── index.ts                         # Mastra instance: agent, workflow, scorers, storage, tracing
│   ├── agents/financial-guardian.ts     # Agent definition and instructions
│   ├── tools/spending-tools.ts          # Agent tools (thin wrappers over lib/spending)
│   ├── workflows/spending-alert-workflow.ts
│   ├── scorers/insight-scorers.ts       # Severity accuracy and text grounding
│   └── lib/spending.ts                  # Deterministic spending math, validation and Zod schemas
├── data/scenarios.ts                    # Labeled evaluation scenarios
└── scripts/
    ├── run-example.ts
    └── eval.ts
test/
└── spending.test.ts                     # node:test unit tests (npm test)
```

## Limitations

- No bank or Open Banking integration: transactions are passed in as input.
- No end-user UI: the agent is used through Mastra Studio or its REST API.
- The scenarios are synthetic, and the historical baseline is a single monthly average.
- Text grounding checks that each figure is derived from the data, not that it is attached to the right claim (the $410 example). Catching that needs an LLM-as-judge scorer, the next planned step.
- The Gemini free tier allows about 20 requests per day and often returns `503 high demand`, so many eval runs fall back to rules. Google may also route a model id to a newer version (`gemini-3.5-flash` requests were served as `gemini-3.6-flash`).
- With Gemini, tool calls are turned off in the workflow's LLM step (`toolChoice: 'none'`), because Gemini rejects tools and structured output in the same request. The step does not need tools anyway: everything is computed before it runs.
