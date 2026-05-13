import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const CpuBudgetPresetSchema = Type.Union([
  Type.Literal('single-core'),
  Type.Literal('half'),
  Type.Literal('all')
]);

// `chartPath` is required in the parsed shape so downstream callers can
// treat it as a definite string. Empty string means "use the computed
// default": Signal K passes `{}` on auto-enable (the plugin has
// `signalk-plugin-enabled-by-default: true` and Signal K does not inject
// JSON-schema defaults at runtime), so the validator normalizes a missing
// `chartPath` to `''` before checking.
export const PluginConfigSchema = Type.Object({
  chartPath: Type.String(),
  cpuBudget: Type.Optional(CpuBudgetPresetSchema)
});

export type CpuBudgetPreset = Static<typeof CpuBudgetPresetSchema>;
export type PluginConfig = Static<typeof PluginConfigSchema>;

export function parsePluginConfig(input: unknown): PluginConfig {
  // Normalize the auto-enable shape (`{}`) by injecting an empty
  // chartPath; doStartup() falls back to the computed default for `''`.
  const normalized =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? { chartPath: '', ...(input as Record<string, unknown>) }
      : input;
  if (Value.Check(PluginConfigSchema, normalized)) {
    return normalized;
  }
  const errors = [...Value.Errors(PluginConfigSchema, normalized)]
    .slice(0, 3)
    .map((e) => `${e.path || '<root>'}: ${e.message}`)
    .join('; ');
  throw new Error(`Invalid plugin configuration — ${errors}`);
}
