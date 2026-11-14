export interface ProviderHelpers {
  search?: "inherit" | "native" | "disabled";
  vision?: "inherit" | "native" | "disabled";
  /** Bare Mistral Conversations model; account entitlement must be verified separately. */
  searchModel?: string;
  /** Bare image-capable model from this provider. */
  visionModel?: string;
}
