#!/usr/bin/env node
/**
 * Habitscore MCP server.
 *
 * Why this exists. Registries make an API *findable*; MCP makes it *installable*. Most
 * agents that would want behavioural analytics — Claude, Cursor, and the agent frameworks
 * built on them — acquire capabilities as MCP tools, not by crawling OpenAPI documents and
 * hand-rolling an x402 payment loop. An API that is only reachable over raw HTTP is
 * invisible to that entire population.
 *
 * The distribution model is deliberate: this runs on the OPERATOR'S machine with the
 * OPERATOR'S wallet. They add it to their MCP config, it signs their payments locally, and
 * their private key never leaves their process. We never custody anything, and there is no
 * account to create — which is the same promise the HTTP surface makes.
 *
 * Tools degrade rather than fail when no wallet is configured: they return the price and
 * the payment terms instead of erroring. An agent can then decide whether to fund a wallet,
 * which is a far better first impression than an exception.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';

/**
 * Config is read from HABITSCORE_* but still honours the older HABITCORE_* names.
 *
 * The brand renamed after v1.0.0 was already on npm, so an installed config out there
 * may still use the old variables. Silently ignoring them would start the server in
 * quote-only mode with no wallet and no explanation, which looks like a broken payment
 * rather than a renamed variable. The fallbacks can be dropped once nothing sets them.
 */
const envCompat = (name: string): string | undefined =>
  process.env[`HABITSCORE_${name}`] ?? process.env[`HABITCORE_${name}`];

const API_BASE = (envCompat('API_URL') ?? 'https://api.mydev-tools.tech').replace(/\/+$/, '');
const PRIVATE_KEY = envCompat('PRIVATE_KEY') ?? process.env.PRIVATE_KEY ?? '';
const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

/**
 * Ceiling on what a single tool call may spend, in USD.
 *
 * An agent loop that calls a paid tool in a retry cycle can spend without bound, and the
 * operator is the one who pays. The cap is enforced against the amount the server actually
 * challenges for, before any signature is produced, so a server that quotes more than
 * expected is refused rather than paid.
 */
const MAX_SPEND_USD = Number(envCompat('MAX_SPEND_USD') ?? '0.25');

/** Shared input contract. Mirrors the API's own schema so a rejection is caught locally. */
const HABIT_ITEM = {
  type: 'object',
  required: ['name', 'completion_rate', 'current_streak', 'best_streak'],
  properties: {
    name: { type: 'string', description: 'Habit or recurring activity name.' },
    completion_rate: { type: 'number', minimum: 0, maximum: 1, description: '0–1 over the observed window.' },
    current_streak: { type: 'integer', minimum: 0, description: 'Consecutive completions right now.' },
    best_streak: { type: 'integer', minimum: 0, description: 'Longest streak ever achieved.' },
    average_mood: { type: 'number', minimum: 1, maximum: 10, description: 'Optional. Mean mood 1–10 on completion days.' },
    mood_correlation: { type: 'number', minimum: -1, maximum: 1, description: 'Optional. Correlation of mood with completion.' },
    energy_trend: { type: 'string', enum: ['rising', 'stable', 'falling'], description: 'Optional.' },
    risk_score: { type: 'number', minimum: 0, maximum: 1, description: 'Optional. Caller-supplied prior risk.' }
  }
} as const;

const HABITS_INPUT = {
  type: 'object',
  required: ['habits'],
  properties: {
    habits: {
      type: 'array',
      minItems: 1,
      maxItems: 25,
      description:
        'Up to 25 habits. Price is per CALL, not per habit — batch aggressively, sending 25 ' +
        'costs the same as sending one.',
      items: HABIT_ITEM
    }
  }
} as const;

const RELIABILITY_TASK = {
  type: 'object',
  required: ['name', 'success_rate', 'current_streak', 'best_streak'],
  properties: {
    name: { type: 'string', description: 'Task, job, pipeline or workflow name.' },
    success_rate: { type: 'number', minimum: 0, maximum: 1, description: 'Successful runs / total runs.' },
    current_streak: { type: 'integer', minimum: 0, description: 'Consecutive successful runs right now.' },
    best_streak: { type: 'integer', minimum: 0, description: 'Longest success streak observed.' },
    runs: { type: 'integer', minimum: 0, description: 'Optional. Total runs; under 10 marks the assessment provisional.' },
    latency_trend: {
      type: 'string',
      enum: ['rising', 'stable', 'falling'],
      description: 'Optional. Direction of p95 latency. Rising is the degradation signal.'
    },
    p95_latency_ms: { type: 'number', minimum: 0, description: 'Optional. Measured p95 latency.' },
    risk_score: { type: 'number', minimum: 0, maximum: 1, description: 'Optional. Your own prior; blended, never overriding.' },
    cadence: { type: 'string', enum: ['continuous', 'hourly', 'daily', 'weekly', 'ad_hoc'], description: 'Optional.' },
    critical: { type: 'boolean', description: 'Optional. True when a failure blocks downstream work. Raises priority.' }
  }
} as const;

interface ToolSpec {
  name: string;
  path: string;
  priceUsd: number;
  description: string;
  inputSchema: Record<string, unknown>;
  buildBody: (args: Record<string, unknown>) => unknown;
}

const TOOLS: ToolSpec[] = [
  {
    // Listed first: an agent scanning tool descriptions is far likelier to be reasoning
    // about its own pipelines than about anyone's jogging.
    name: 'analyze_reliability',
    path: '/agent/v1/reliability/analyze',
    priceUsd: 0.08,
    description:
      'Reliability analysis for up to 25 recurring tasks, jobs, pipelines or scheduled ' +
      'workflows in one call. Returns a reliability score and grade (healthy/degrading/' +
      'unstable/failing) per task, lapse risk, streak recovery, latency-trend warnings, and ' +
      'remediation actions ranked by priority so the list is actionable top-down. Use for ' +
      'cron and pipeline monitoring, flaky-job triage, SLA and uptime adherence, agent task ' +
      'reliability, and deciding what to fix first. Deterministic threshold analysis over the ' +
      'figures you supply — no model, no log parsing, no root-cause inference. Costs $0.08 in ' +
      'USDC on Base.',
    inputSchema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        system: { type: 'string', maxLength: 120, description: 'Optional label to correlate the response with a system.' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description: 'Price is per CALL, not per task — sending 25 costs the same as sending one.',
          items: RELIABILITY_TASK
        }
      }
    },
    buildBody: (a) => ({ tasks: a.tasks, system: a.system })
  },
  {
    name: 'analyze_behaviour',
    path: '/agent/v1/habits/analyze',
    priceUsd: 0.05,
    description:
      'Behavioural analysis over up to 25 habits or recurring activities in one call. Returns ' +
      'adherence and consistency scores, streak momentum, lapse-risk flags, highlights, ' +
      'watchouts and recommendations. Use for adherence monitoring, routine optimisation, ' +
      'engagement and churn-risk signals, and streak analysis. Costs $0.05 in USDC on Base.',
    inputSchema: HABITS_INPUT,
    buildBody: (a) => ({ habits: a.habits })
  },
  {
    name: 'recommend_next_actions',
    path: '/agent/v1/habits/recommend',
    priceUsd: 0.03,
    description:
      'Ranked next-best action per habit, each with a rationale and a priority score. The ' +
      'cheapest endpoint, deterministic and CPU-only, so it is suitable for high-frequency ' +
      'loops. Costs $0.03 in USDC on Base.',
    inputSchema: HABITS_INPUT,
    buildBody: (a) => ({ habits: a.habits })
  },
  {
    name: 'extract_insights',
    path: '/agent/v1/habits/insights',
    priceUsd: 0.05,
    description:
      'Condensed behavioural highlights and watchouts — patterns, correlations and risk ' +
      'signals — without the full aggregate breakdown. Use when you want the narrative rather ' +
      'than the numbers. Costs $0.05 in USDC on Base.',
    inputSchema: HABITS_INPUT,
    buildBody: (a) => ({ habits: a.habits })
  },
  {
    name: 'build_habit_plan',
    path: '/agent/v1/habits/plan',
    priceUsd: 0.1,
    description:
      'Multi-week plan for ONE habit: weekly targets and dated milestones over a chosen ' +
      'horizon. The most compute-intensive endpoint. Costs $0.10 in USDC on Base.',
    inputSchema: {
      type: 'object',
      required: ['habit'],
      properties: {
        habit: HABIT_ITEM,
        horizon_days: {
          type: 'integer',
          minimum: 7,
          maximum: 60,
          default: 21,
          description: 'Planning horizon in days.'
        }
      }
    },
    buildBody: (a) => ({ habit: a.habit, horizon_days: a.horizon_days ?? 21 })
  }
];

// ── payment ───────────────────────────────────────────────────────────────────

let paymentClient: x402Client | null = null;
let payerAddress: string | null = null;

function paymentReady(): boolean {
  if (!PRIVATE_KEY) return false;
  if (paymentClient) return true;
  try {
    const key = (PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`;
    const account = privateKeyToAccount(key);
    payerAddress = account.address;
    const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
    paymentClient = registerExactEvmScheme(new x402Client(), {
      signer: toClientEvmSigner(account, publicClient)
    });
    return true;
  } catch {
    // A malformed key must not crash the server — every tool still works in
    // quote-only mode, and the operator gets a clear message instead of a stack trace.
    return false;
  }
}

/** Atomic units in the challenge are USDC's 6-decimal minor units. */
function quotedUsd(challenge: unknown): number | null {
  const accepts = (challenge as { accepts?: Array<{ amount?: string }> })?.accepts;
  const amount = Array.isArray(accepts) ? accepts[0]?.amount : undefined;
  if (typeof amount !== 'string') return null;
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? n / 1_000_000 : null;
}

function decodeChallenge(header: string): unknown {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

interface CallResult {
  ok: boolean;
  text: string;
}

async function callPaidTool(spec: ToolSpec, body: unknown): Promise<CallResult> {
  const url = `${API_BASE}${spec.path}`;
  const payload = JSON.stringify(body);

  // 1. Provoke the challenge. Always happens, so the quoted price is known before any
  //    decision to spend is taken.
  const first = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(30_000)
  });

  if (first.status === 200) {
    return { ok: true, text: await first.text() };
  }

  if (first.status !== 402) {
    return { ok: false, text: `Upstream returned HTTP ${first.status}: ${(await first.text()).slice(0, 300)}` };
  }

  const header = first.headers.get('payment-required');
  const challenge = header ? decodeChallenge(header) : null;
  const quoted = challenge ? quotedUsd(challenge) : null;

  if (!paymentReady()) {
    return {
      ok: false,
      text:
        `This tool costs ${quoted !== null ? `$${quoted.toFixed(4)}` : `about $${spec.priceUsd}`} ` +
        `per call, paid in USDC on Base.\n\n` +
        `No wallet is configured, so nothing was charged and no result was fetched.\n\n` +
        `To enable it, set HABITSCORE_PRIVATE_KEY to the key of a wallet holding a small ` +
        `amount of USDC on Base. Use a dedicated wallet with only what you intend to spend — ` +
        `the key is used for local signing only and never leaves this process.\n\n` +
        `Payment terms: ${JSON.stringify(challenge ?? {}, null, 2).slice(0, 700)}`
    };
  }

  // 2. Refuse a server that quotes more than the operator authorised. Checked BEFORE
  //    signing, so an overpriced challenge costs nothing.
  if (quoted === null) {
    return { ok: false, text: 'Could not read a price from the payment challenge; refusing to pay.' };
  }
  if (quoted > MAX_SPEND_USD) {
    return {
      ok: false,
      text:
        `Refused: the server quoted $${quoted.toFixed(4)} but HABITSCORE_MAX_SPEND_USD is ` +
        `$${MAX_SPEND_USD.toFixed(4)}. Nothing was signed or charged. Raise the limit only if ` +
        `you expect this price.`
    };
  }

  // 3. Sign locally and retry.
  //
  // Sent as PAYMENT-SIGNATURE, not X-PAYMENT. The x402 server library reads
  // `payment-signature` internally while the spec sends `x-payment`; sending the name the
  // server actually reads avoids depending on any compatibility shim being present on the
  // far side.
  const signed = await paymentClient!.createPaymentPayload(challenge as never);
  const encoded = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64');

  const second = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': encoded,
      'X-PAYMENT': encoded
    },
    body: payload,
    signal: AbortSignal.timeout(45_000)
  });

  const text = await second.text();
  if (second.status !== 200) {
    return {
      ok: false,
      text: `Payment was submitted but the server returned HTTP ${second.status}: ${text.slice(0, 300)}`
    };
  }

  // Surface the settlement reference so the operator can verify the charge on-chain.
  let settlement = '';
  const settleHeader = second.headers.get('x-payment-response');
  if (settleHeader) {
    try {
      const tx = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'))?.transaction;
      if (tx) settlement = `\n\n---\nPaid $${quoted.toFixed(4)} USDC. Transaction: ${tx}`;
    } catch {
      /* advisory only */
    }
  }

  return { ok: true, text: text + settlement };
}

// ── server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'habitscore', version: '1.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map<Tool>((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema']
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const spec = TOOLS.find((t) => t.name === request.params.name);
  if (!spec) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  }

  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    const result = await callPaidTool(spec, spec.buildBody(args));
    return {
      isError: !result.ok,
      content: [{ type: 'text', text: result.text }]
    };
  } catch (err) {
    // Never throw out of a tool handler: an MCP client shows a generic failure and the
    // operator has no idea whether they were charged. Saying so explicitly matters.
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `Tool call failed before or during payment: ${(err as Error).message}\n\n` +
            `If no transaction reference is shown above, no funds moved.`
        }
      ]
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only. stdout is the MCP protocol channel — writing anything else to it
  // corrupts the stream and the client disconnects with a parse error.
  process.stderr.write(
    `habitscore-mcp ready · api ${API_BASE} · ` +
      (paymentReady()
        ? `wallet ${payerAddress} · max $${MAX_SPEND_USD}/call\n`
        : `NO WALLET (quote-only; set HABITSCORE_PRIVATE_KEY to enable purchases)\n`)
  );
}

main().catch((err) => {
  process.stderr.write(`habitscore-mcp failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
