import type Anthropic from '@anthropic-ai/sdk';
import { observations } from '../db/repositories.js';

/**
 * Cost self-awareness. Every run's token usage is folded into ONE sys.turn
 * observation (value = estimated USD), so Philip (/status) and the agent
 * itself (query_observations on 'sys.turn') can both see what running the
 * keeper actually costs — per day, per month, over time.
 */

/**
 * USD per million tokens: [input, output, cache write, cache read]. Keyed by a
 * model-id prefix; first match wins (so list more specific keys first). Covers
 * both the native Anthropic ids and the OpenRouter slugs Jarvis runs on when
 * MODEL_PROVIDER=openrouter. OpenRouter has no separate cache pricing → 0s.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
  // Native Gemini ids (MODEL_PROVIDER=gemini) + OpenRouter slugs. Approx list
  // prices for the cheap-tier stopgap models. List longer keys before prefixes.
  // Gemini 3 family (approximate list prices — reasoning models, output incl.
  // thinking tokens). Keep specific keys before the generic 'gemini' catch-all.
  'gemini-3.1-flash-lite': [0.15, 0.6, 0, 0],
  'gemini-3.1-pro': [2, 12, 0, 0],
  'gemini-3.5-flash': [0.5, 3, 0, 0],
  'gemini-3-flash': [0.5, 3, 0, 0],
  'gemini-3': [2, 12, 0, 0],
  'gemini-2.5-flash-lite': [0.1, 0.4, 0, 0],
  'gemini-2.5-flash': [0.3, 2.5, 0, 0],
  'gemini-2.0-flash': [0.1, 0.4, 0, 0],
  'gemini': [0.3, 2.5, 0, 0],
  'google/gemini-2.5-flash-lite': [0.1, 0.4, 0, 0],
  'google/gemini-2.5-flash': [0.3, 2.5, 0, 0],
  'google/gemini-2.0-flash': [0.1, 0.4, 0, 0],
  'google/gemini': [0.3, 2.5, 0, 0],
  'openai/gpt-5-mini': [0.25, 2, 0, 0],
  'openai/gpt-5-nano': [0.05, 0.4, 0, 0],
  'openai/gpt-5': [1.25, 10, 0, 0],
  // Native OpenAI ids (MODEL_PROVIDER=openai) — this is what Keeper actually
  // runs on now. Without these keys every turn fell through to the unknown-model
  // default below, i.e. /status was quoting Gemini Flash prices for a GPT bill.
  // Cache reads are the 4th column: prefix caching is automatic and discounted,
  // and there is no separate cache-write charge, hence 0 in the 3rd.
  // NOTE: these are gpt-5-tier list prices carried over to the 5.6 ids. Check
  // them against the current OpenAI pricing page — they drive /status, and a
  // wrong number here is the exact problem this block exists to fix.
  'gpt-5.6-luna': [1.25, 10, 0, 0.125],
  'gpt-5.6-mini': [0.25, 2, 0, 0.025],
  'gpt-5.6': [1.25, 10, 0, 0.125],
  'gpt-5-mini': [0.25, 2, 0, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0, 0.005],
  'gpt-5': [1.25, 10, 0, 0.125],
};

function priceFor(model: string): [number, number, number, number] {
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key] as [number, number, number, number];
  }
  // Unknown model: don't pretend it's a pricey Claude — assume a cheap tier so
  // /status under-promises rather than alarms. (Set a PRICES key to be exact.)
  return [0.3, 2.5, 0, 0];
}

export interface UsageTotals {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

export function sumUsage(usages: Anthropic.Usage[]): UsageTotals {
  const t: UsageTotals = { in: 0, out: 0, cw: 0, cr: 0 };
  for (const u of usages) {
    t.in += u.input_tokens ?? 0;
    t.out += u.output_tokens ?? 0;
    t.cw += u.cache_creation_input_tokens ?? 0;
    t.cr += u.cache_read_input_tokens ?? 0;
  }
  return t;
}

export function estimateCostUsd(model: string, t: UsageTotals): number {
  const [pin, pout, pcw, pcr] = priceFor(model);
  return (t.in * pin + t.out * pout + t.cw * pcw + t.cr * pcr) / 1e6;
}

/** Fire-and-forget: one sys.turn observation per run. Never blocks or throws. */
export function logUsage(kind: string, model: string, usages: Anthropic.Usage[]): void {
  if (usages.length === 0) return;
  const t = sumUsage(usages);
  const usd = estimateCostUsd(model, t);
  void observations
    .log({
      metric: 'sys.turn',
      value: Math.round(usd * 1e6) / 1e6,
      unit: 'usd',
      note: `${kind} in:${t.in} out:${t.out} cw:${t.cw} cr:${t.cr} ${model}`,
      source: 'system',
    })
    .catch((err) => console.error('[usage] failed to log:', err));
}
