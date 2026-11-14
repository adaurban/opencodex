import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalMistralChat } from "../providers/mistral-destination";

export type { ProviderHelpers } from "../types/provider-helpers";

export function providerHelpersConfigError(value: unknown, provider: OcxProviderConfig): string | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "helpers must be an object";
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["search", "vision", "searchModel", "visionModel"].includes(key))) return "helpers contains an unknown field";
  for (const key of ["search", "vision"]) {
    if (row[key] !== undefined && !["inherit", "native", "disabled"].includes(row[key] as string)) return "helpers selection must be inherit, native or disabled";
  }
  for (const key of ["searchModel", "visionModel"]) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(row[key] as string))) return "helpers models must be bare model identifiers";
  }
  if ((row.search === "native" || row.vision === "native") && !isCanonicalMistralChat(provider)) return "native helpers require a canonical Mistral Chat provider";
  if (row.search === "native" && !row.searchModel) return "native search requires an explicit searchModel";
  if (row.vision === "native" && !row.visionModel) return "native vision requires an explicit visionModel";
}

/** Request-local overrides; never mutate the saved global helper settings. */
export function providerVisionConfig(config: OcxConfig, provider: OcxProviderConfig, providerName?: string): OcxConfig {
  const policy = provider.helpers;
  if (!policy || !policy.vision || policy.vision === "inherit") return config;
  const error = providerHelpersConfigError(policy, provider);
  if (error) throw new Error(error);
  if (policy.vision === "disabled") return { ...config, visionSidecar: { ...config.visionSidecar, enabled: false } };
  if (!providerName || config.providers[providerName]?.disabled) throw new Error("native vision provider is unavailable");
  return { ...config, visionSidecar: { ...config.visionSidecar, enabled: true, backend: "routed", model: `${providerName}/${policy.visionModel}` } };
}
