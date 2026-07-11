// Token-based cost fallback for OpenAI-compatible providers (LiteLLM).
//
// When the opencode CLI talks to our LiteLLM proxy (openai-compat passthrough),
// `step_finish` events do not populate `part.cost`, so `parse.ts` accumulates
// `costUsd = 0`. We catch that at the execute.ts return site and substitute a
// token-based estimate using the per-model rates below.
//
// TODO(BLO-7436): VERIFY these rates against openai.com/pricing before each
// release that touches this file. Refresh policy: bump whenever LiteLLM's
// `model_prices_and_context_window.json` or OpenAI's published pricing page
// changes. Tag the bump in CHANGELOG so the rollback path is obvious.
//
// Fail-safe shape: unknown model returns null, all-zero usage returns null,
// null model returns null. The caller treats null as "no fallback available"
// and preserves the existing $0 / `billingType: "unknown"` behavior, so an
// out-of-date table cannot produce negative cost or break the run — it just
// misses the cost line until the table is refreshed.
export const OPENAI_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "openai/gpt-5.6-sol": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "openai/gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "openai/gpt-5.6-luna": { input: 1.0, cachedInput: 0.1, output: 6.0 },
  "openai/gpt-5.5": { input: 3.0, cachedInput: 0.3, output: 12.0 },
  "openai/gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 10.0 },
  "openai/gpt-5.4-mini": { input: 0.5, cachedInput: 0.05, output: 2.0 },
  "openai/gpt-5.2-codex": { input: 1.5, cachedInput: 0.15, output: 6.0 },
};

export function computeOpenAICompatibleCost(
  model: string | null,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number | null {
  if (!model) return null;
  const rate = OPENAI_PRICING_USD_PER_MTOK[model];
  if (!rate) return null;
  if (usage.inputTokens + usage.cachedInputTokens + usage.outputTokens === 0) return null;
  return (
    (usage.inputTokens * rate.input) / 1_000_000 +
    (usage.cachedInputTokens * rate.cachedInput) / 1_000_000 +
    (usage.outputTokens * rate.output) / 1_000_000
  );
}
