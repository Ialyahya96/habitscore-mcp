# habitscore-mcp

MCP server for **Habitscore** — analytics over anything with a recurring completion history.

Two families of tools, one engine:

- **Operational reliability** — score recurring tasks, jobs, pipelines and scheduled
  workflows. Success rate, streak recovery, lapse risk, latency-trend warnings, and
  remediation ranked by priority.
- **Behavioural analytics** — the same scoring over habit and routine data. Adherence,
  consistency, momentum, lapse risk, next-best actions, multi-week plans.

Pays per call with [x402](https://x402.org): USDC on Base, no account, no API key, no
subscription. From **$0.03** per call.

Walkthrough with a working x402 client example: <https://mydev-tools.tech/agents/reliability/>

## Why it works this way

The server runs on **your** machine with **your** wallet. It signs payments locally and the
private key never leaves the process. Nothing is custodied on our side and there is no
account to create — the same promise the HTTP API makes.

Without a wallet configured, every tool still works in **quote-only** mode: it returns the
price and the payment terms instead of erroring, so you can see what a call would cost
before funding anything.

## Install

```jsonc
// Claude Desktop: claude_desktop_config.json
// Cursor:         ~/.cursor/mcp.json
{
  "mcpServers": {
    "habitscore": {
      "command": "npx",
      "args": ["-y", "habitscore-mcp"],
      "env": {
        "HABITSCORE_PRIVATE_KEY": "0x…",
        "HABITSCORE_MAX_SPEND_USD": "0.25"
      }
    }
  }
}
```

Omit `HABITSCORE_PRIVATE_KEY` to start in quote-only mode.

## Wallet

Use a **dedicated wallet holding only what you intend to spend.** Fund it with a small
amount of USDC on Base (contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). You do not
need ETH: under EIP-3009 you sign the authorisation off-chain and the facilitator submits
the transaction and pays the gas.

`HABITSCORE_MAX_SPEND_USD` caps what a single tool call may spend, and is checked against the
price the server actually quotes **before anything is signed**. An agent loop that retries a
paid tool can otherwise spend without bound, and you are the one paying — so a server that
quotes more than you authorised is refused rather than paid.

## Tools

| Tool | Price | Returns |
|---|---|---|
| `analyze_reliability` | $0.08 | Reliability score and grade per task, lapse risk, latency-trend warnings, priority-ranked remediation |
| `analyze_behaviour` | $0.05 | Adherence and consistency scores, streak momentum, lapse-risk flags, highlights, watchouts, recommendations |
| `recommend_next_actions` | $0.03 | Ranked next-best action per habit with rationale and priority |
| `extract_insights` | $0.05 | Condensed patterns, correlations and risk signals |
| `build_habit_plan` | $0.10 | Multi-week plan for one habit: weekly targets and dated milestones |

**Price is per call, not per habit.** `analyze_behaviour` accepts up to 25 habits for the
same $0.05, so batching is by far the cheapest way to use this.

## Input

Reliability:

```json
{
  "system": "billing-pipeline",
  "tasks": [
    {
      "name": "nightly-etl",
      "success_rate": 0.83,
      "current_streak": 0,
      "best_streak": 52,
      "runs": 210,
      "latency_trend": "rising",
      "p95_latency_ms": 38000,
      "cadence": "daily",
      "critical": true
    }
  ]
}
```

`name`, `success_rate` (0–1), `current_streak` and `best_streak` are required. Note that
**`latency_trend: "rising"` is the degradation signal** — the opposite polarity to the
behavioural tools, where a falling trend is the warning.

Behavioural:

```json
{
  "habits": [
    {
      "name": "Morning run",
      "completion_rate": 0.72,
      "current_streak": 9,
      "best_streak": 21,
      "average_mood": 7.4,
      "energy_trend": "rising"
    }
  ]
}
```

`name`, `completion_rate` (0–1), `current_streak` and `best_streak` are required. `average_mood`,
`mood_correlation`, `energy_trend` and `risk_score` are optional and sharpen the result.

"Habit" is the domain vocabulary, but the analysis applies to any **recurring activity with
completion history** — training schedules, medication adherence, study routines, recurring
operational tasks.

## What it does not do

The engine is deterministic and CPU-only: threshold rules and arithmetic over the numbers
you supply. Same input, same output, every time.

It is **not** a language model and does not generate prose beyond composing its findings. It
does not store anything — the agent endpoints are stateless, accept no user identifier, and
cannot read or infer any stored history. It is not medical, psychological or financial
advice.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `HABITSCORE_PRIVATE_KEY` | — | Wallet key for signing payments. Omit for quote-only mode. |
| `HABITSCORE_MAX_SPEND_USD` | `0.25` | Hard cap per tool call, enforced before signing. |
| `HABITSCORE_API_URL` | `https://api.mydev-tools.tech` | API origin. |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base RPC for balance reads and signing context. |

## Verifying a charge

Every successful paid call appends the settlement transaction hash to the tool output. Open
it on [basescan.org](https://basescan.org) to confirm the amount and recipient independently
of anything this server reports.

## Links

- API: <https://api.mydev-tools.tech>
- Overview: <https://mydev-tools.tech>
- OpenAPI: <https://api.mydev-tools.tech/openapi.json>
- Capabilities: <https://api.mydev-tools.tech/v1/capabilities>
- Pricing and volume rebate: <https://api.mydev-tools.tech/agent/v1/pricing>

## Volume rebate

Verified spend earns credits back — 5% from $10 lifetime, 10% from $100, 15% from $1,000,
with higher rate limits at each tier. Credits are returned inline in the response that earns
them and are redeemed with an `X-Agent-Credit` header on a later call.

MIT licensed.
