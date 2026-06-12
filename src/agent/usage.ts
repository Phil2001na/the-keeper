import type Anthropic from '@anthropic-ai/sdk';
import { observations } from '../db/repositories.js';

/**
 * Cost self-awareness. Every run's token usage is folded into ONE sys.turn
 * observation (value = estimated USD), so Philip (/status) and the agent
 * itself (query_observations on 'sys.turn') can both see what running the
 * keeper actually costs — per day, per month, over time.
 */

/** USD per million tokens: [input, output, cache write, cache read]. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
};

function priceFor(model: string): [number, number, number, number] {
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key] as [number, number, number, number];
  }
  return PRICES['claude-sonnet-4-6'] as [number, number, number, number];
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
