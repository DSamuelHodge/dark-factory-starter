// providers/meta.ts — HAND-MAINTAINED (not generated; skills.sh clean spares
// this directory). Registers the `meta` model provider: an OpenAI-compatible
// endpoint that stands in for OpenAI in this project (no OpenAI key here).
//
// Key resolution order: $META_API_KEY first, then `pass show meta/api-key`
// (needs a warm gpg-agent cache for non-interactive use — run
// `pass show meta/api-key > /dev/null` once per cache TTL). Local runs
// populate $META_API_KEY from gitignored, mode-600 `.dev.vars`. The key is
// never committed to the repo.
// Base URL and model IDs are NOT secrets: env-overridable defaults below.
//
// Importing this module registers the provider as a side effect, so a
// generated agent needs only `import '../../providers/meta.ts';`. The
// future Cloudflare app entry (src/app.ts) should import it the same way.

import { execFileSync } from 'node:child_process';
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const META_PROVIDER_ID = 'meta';
const META_BASE_URL = process.env.META_BASE_URL || 'https://api.meta.ai/v1';
// Models served through this endpoint. Adding a model ID here is all it
// takes for `useModel('meta/<id>')` to resolve; metadata below is our best
// known shape (unknown context window would disable threshold compaction,
// so prefer stating what the endpoint documents).
const META_MODELS = [
  {
    id: 'muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 (Meta)',
    contextWindow: 128000,
    maxTokens: 8192,
  },
];

let cachedKey: string | null = null;

export function metaApiKey(): string {
  const fromEnv = (process.env.META_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (!cachedKey) {
    try {
      cachedKey = execFileSync('pass', ['show', 'meta/api-key'], {
        encoding: 'utf8',
        timeout: 15000,
      })
        .split('\n')[0]
        .trim();
    } catch {
      cachedKey = null;
    }
    if (!cachedKey) {
      throw new Error(
        'Meta API key unavailable: set $META_API_KEY or warm the gpg-agent cache ' +
          '(`pass show meta/api-key > /dev/null`) so `pass` can read it non-interactively.'
      );
    }
  }
  return cachedKey;
}

export function registerMetaProvider(): void {
  setProvider(
    createProvider({
      id: META_PROVIDER_ID,
      auth: {
        apiKey: {
          name: 'META_API_KEY or pass meta/api-key',
          resolve: async () => ({ auth: { apiKey: metaApiKey() } }),
        },
      },
      models: META_MODELS.map((m) => ({
        ...m,
        api: 'openai-completions',
        provider: META_PROVIDER_ID,
        baseUrl: META_BASE_URL,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      api: openAICompletionsApi(),
    })
  );
}

// Auto-register on import: generated agents get the provider with one import.
registerMetaProvider();
