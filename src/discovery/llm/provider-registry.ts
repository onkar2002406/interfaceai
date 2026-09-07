/**
 * The set of language-model providers discovery can run against, and the logic
 * for picking one.
 *
 * Adding a provider is a configuration entry, not a class, because every entry
 * here speaks the same wire format. That is the point of keeping the
 * `LlmProvider` interface narrow: the choice of model host is genuinely a
 * deployment decision, not an architectural one.
 *
 * Selection order when `--provider` is not given: whichever key is actually
 * present in the environment, then the scripted fixture. Defaulting to a
 * provider whose key is missing produces a confusing failure three seconds into
 * a browser launch; defaulting to what is configured just works.
 */

import { ScriptedProvider } from './scripted-provider.js';
import { OpenAiCompatibleProvider, type ProviderConfig } from './openai-compatible-provider.js';
import { FailoverProvider, type ProviderSwitch } from './failover-provider.js';
import type { LlmProvider } from './llm-provider.js';

export const PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    // Tool calling is what discovery needs, and this is the strongest model on
    // Groq's free tier that supports it reliably with `tool_choice: required`.
    defaultModel: 'openai/gpt-oss-120b',
    // Groq's free tier currently exposes no vision model that also supports tool
    // calling. Discovery works without one — the model acts by element id from
    // the text inventory, and the screenshot was always corroboration. It is
    // still captured as run evidence, just not sent to the model.
    supportsVision: false,
    consoleUrl: 'https://console.groq.com/keys',
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o',
    supportsVision: true,
    consoleUrl: 'https://platform.openai.com/settings/organization/billing',
  },
};

export type ProviderName = keyof typeof PROVIDERS | 'scripted';

/** The provider to use when none was named. */
export function defaultProviderName(): ProviderName {
  for (const name of Object.keys(PROVIDERS)) {
    if (process.env[PROVIDERS[name]!.apiKeyEnv]) return name;
  }
  return 'scripted';
}

export function createProvider(
  name: string,
  opts: {
    model?: string;
    scriptedParams?: Record<string, string>;
    onSwitch?: (s: ProviderSwitch) => void;
  } = {},
): LlmProvider {
  if (name === 'scripted') return new ScriptedProvider(opts.scriptedParams ?? {});

  const config = PROVIDERS[name];
  if (!config) {
    throw new Error(
      `Unknown provider "${name}". Available: ${[...Object.keys(PROVIDERS), 'scripted'].join(', ')}.`,
    );
  }

  const primary = new OpenAiCompatibleProvider(config, opts.model ? { model: opts.model } : {});

  // Chain in every *other* configured host as a fallback, in table order.
  //
  // A model override is deliberately not propagated: `--model gpt-oss-120b`
  // names a model on the provider it was given for, and forcing that string
  // onto the fallback would guarantee a 404 at the exact moment the fallback is
  // needed. Each fallback uses its own `modelEnv` / `defaultModel`.
  const fallbacks = Object.keys(PROVIDERS)
    .filter((id) => id !== name && process.env[PROVIDERS[id]!.apiKeyEnv])
    .map((id) => new OpenAiCompatibleProvider(PROVIDERS[id]!));

  if (fallbacks.length === 0) return primary;
  return new FailoverProvider([primary, ...fallbacks], (s) => {
    // Always on the console, whether or not a caller asked for the callback.
    // Moving from a free key onto a paid one is a thing you want to find out
    // about while it is happening, not on a statement.
    console.warn(`  ! model provider ${s.from} failed (${s.kind}); falling back to ${s.to}`);
    opts.onSwitch?.(s);
  });
}

/** True when a fallback chain would actually be built — for CLI and panel output. */
export function describeChainFor(name: string): string {
  const others = Object.keys(PROVIDERS).filter((id) => id !== name && process.env[PROVIDERS[id]!.apiKeyEnv]);
  return others.length === 0 ? '' : ` (falls back to ${others.join(', ')})`;
}

/** True if a live provider could actually run right now. */
export function hasLiveProviderConfigured(): boolean {
  return defaultProviderName() !== 'scripted';
}

/** Human-readable list for CLI help and error messages. */
export function describeProviders(): string {
  return Object.values(PROVIDERS)
    .map((p) => `${p.id} (${p.apiKeyEnv}, default model ${p.defaultModel})`)
    .concat('scripted (offline fixture, no key needed)')
    .join('; ');
}
