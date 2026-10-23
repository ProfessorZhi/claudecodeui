import { providerModelsDb } from '@/modules/database/index.js';
import { isAllowedLaunchEnvKey, resolveContextWindow } from '@/modules/providers/services/launch-spec.service.js';
import type { LLMProvider, ResolvedLaunchSpec } from '@/shared/types.js';

/**
 * Seam for the compile-path key filter; tests substitute a lax one to prove the guard is load-bearing.
 * Re-exported through the providers barrel for those tests, which live in this module's tests/.
 */
export type LaunchSpecGuards = { isAllowedKey: (key: string) => boolean };

const DEFAULT_GUARDS: LaunchSpecGuards = { isAllowedKey: isAllowedLaunchEnvKey };

/**
 * Compiles the spawn env for one `(provider, modelId)` from the model library.
 * Consumed by the Claude SDK runtime and the shell websocket service. Unknown
 * models (all built-ins) and models without config compile to the passthrough
 * spec. Row semantics: `value`/`secret` set the key, `envref` reads the server
 * process env (missing variable => warning and the key is NOT set, so nothing
 * silently falls back to an inherited value the row was meant to replace),
 * `unset` lists the key in `unsetEnv` for removal from the final spawn env.
 * Keys are re-filtered through the allowlist on every compile.
 */
export function resolveModelLaunchSpec(
  provider: LLMProvider,
  modelId: string | null | undefined,
  guards: LaunchSpecGuards = DEFAULT_GUARDS,
): ResolvedLaunchSpec & { unsetEnv: string[] } {
  const spec: ResolvedLaunchSpec & { unsetEnv: string[] } = {
    env: {},
    unsetEnv: [],
    argv: [],
    contextWindow: resolveContextWindow(),
    warnings: [],
  };
  const record = modelId ? providerModelsDb.findCustomProviderModelByModelId(provider, modelId) : null;
  if (!record?.config) {
    return spec;
  }

  for (const row of record.config.env) {
    if (!guards.isAllowedKey(row.key)) {
      spec.warnings.push(`Environment variable ${row.key} is not allowed in a model config and was dropped`);
      continue;
    }
    if (row.kind === 'unset') {
      spec.unsetEnv.push(row.key);
    } else if (row.kind === 'envref') {
      const value = row.value ? process.env[row.value] : undefined;
      if (value) {
        spec.env[row.key] = value;
      } else {
        spec.warnings.push(`Environment variable ${row.value ?? ''} is not set; ${row.key} was not exported`);
      }
    } else if (typeof row.value === 'string') {
      spec.env[row.key] = row.value;
    }
  }

  // Context window: entry (MAX_CONTEXT_TOKENS row) -> CONTEXT_WINDOW -> 160000, same tiers as profiles.
  spec.contextWindow = resolveContextWindow(spec.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return spec;
}

/**
 * Returns the compiled CLAUDE_CODE_MAX_CONTEXT_TOKENS row of one model entry (the single source of that
 * model's context window), or undefined when the entry has no such row. Read from the same compile as the
 * spawn env, so the exported value and the usage `total` cannot diverge.
 * Consumed by the providers module (Claude SDK runtime and token-usage service).
 */
export function resolveModelContextWindowRow(
  provider: LLMProvider,
  modelId: string | null | undefined,
): string | undefined {
  return resolveModelLaunchSpec(provider, modelId).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
}
