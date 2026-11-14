import type { AuxiliaryModelSend } from "../lib/request-execution-budget";
import { estimateTokens } from "../lib/token-estimate";
import { providerEgressSendInit } from "../lib/provider-egress";
/** Mistral hosted search uses Conversations; main inference remains on Chat. */
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalMistralChat } from "../providers/mistral-destination";
import { resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import type { OcxProviderTransport } from "../providers/xai-transport";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { MAX_SIDECAR_RESPONSE_BYTES } from "./parse";
import { appendSafeWebSearchSource } from "./sources";
import type { SidecarOutcome, SidecarSettings } from "./executor";

const failure = (error: string): SidecarOutcome => ({ text: "", sources: [], error });
function rec(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only executed searches with assistant text and real HTTP citations count as results. */
export function mapMistralSearchResponse(payload: unknown): SidecarOutcome {
  if (!rec(payload) || !Array.isArray(payload.outputs)) return failure("Mistral search returned an invalid body");
  const text: string[] = [];
  const sources: SidecarOutcome["sources"] = [];
  let executed = false;
  for (const entry of payload.outputs) {
    if (!rec(entry)) continue;
    if (entry.type === "tool.execution" && entry.name === "web_search") executed = true;
    if (entry.type !== "message.output" || entry.role !== "assistant") continue;
    if (typeof entry.content === "string") text.push(entry.content);
    if (!Array.isArray(entry.content)) continue;
    for (const chunk of entry.content) {
      if (!rec(chunk)) continue;
      if (chunk.type === "text" && typeof chunk.text === "string") text.push(chunk.text);
      if (chunk.type !== "tool_reference" || chunk.tool !== "web_search" || typeof chunk.url !== "string") continue;
      appendSafeWebSearchSource(sources, { url: chunk.url, title: chunk.title });
    }
  }
  if (!executed) return failure("Mistral did not execute web_search");
  if (!text.join("").trim()) return failure("Mistral search returned no answer");
  // Live Conversations replies can use string content with Markdown citations instead of chunks.
  // Prefer structured references; a text link is supporting evidence, not verified provenance.
  if (!sources.length) {
    for (const part of text) {
      for (const match of part.matchAll(/(?<!!)\[([^\]\r\n]{1,256})\]\((https?:\/\/[^\s<>()]+)\)/gu)) {
        appendSafeWebSearchSource(sources, { url: match[2], title: match[1] });
      }
    }
  }
  if (!sources.length) return failure("Mistral search returned no web citations");
  return { text: text.join("\n"), sources };
}

export async function runMistralWebSearch(
  query: string,
  sidecar: { providerName: string; provider: OcxProviderConfig; config: OcxConfig },
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  dispatchSidecarSend?: AuxiliaryModelSend,
): Promise<SidecarOutcome> {
  const { config, providerName, provider } = sidecar;
  if (!isCanonicalMistralChat(provider) || provider.disabled) return failure("Mistral search provider is unavailable");
  const current = resolveCurrentProviderApiKeyTransport(config, providerName, provider) as OcxProviderTransport | null;
  if (!current || !isCanonicalMistralChat(current) || !current.apiKey) return failure("Mistral search credential is unavailable");
  const linked = signalWithTimeout(settings.timeoutMs, abortSignal);
  const leave = sidecarEnter("web-search");
  try {
    linked.signal.throwIfAborted();
    // One send, no cross-account/provider fallback. No caller headers or conversation history.
    const transport = current.fetch ?? fetch;
    const url = "https://api.mistral.ai/v1/conversations";
    const body = JSON.stringify({
      model: settings.model, inputs: query, store: false,
      instructions: "Always use web_search to answer the query with current sources. Never answer from memory alone.",
      tools: [{ type: "web_search" }], completion_args: { max_tokens: 2048 },
    });
    const send = () => {
      const live = resolveCurrentProviderApiKeyTransport(config, providerName, provider);
      if (!live || !isCanonicalMistralChat(live) || live.apiKey !== current.apiKey) throw new Error("Mistral helper credential changed");
      return transport(url, {
        ...providerEgressSendInit({ providerName, provider: current }, transport, url),
        method: "POST", redirect: "manual", signal: linked.signal,
        headers: { "Content-Type": "application/json", authorization: `Bearer ${current.apiKey}` },
        body,
      });
    };
    const response = await (dispatchSidecarSend ? dispatchSidecarSend({
      poolId: providerName, identityId: "", targetKey: `mistral-search:${crypto.randomUUID()}`,
      estimate: { inputTokens: Math.max(1, estimateTokens(body, settings.model)), outputCeilingTokens: 2048 },
    }, send) : send());
    const detach = cancelBodyOnAbort(response.body, linked.signal);
    try {
      const body = await readBoundedResponseBytes(response, { maxBytes: MAX_SIDECAR_RESPONSE_BYTES, signal: linked.signal });
      // Refusal bodies may contain secrets or account details; expose status only.
      if (!response.ok) return failure(`Mistral search HTTP ${response.status}`);
      if (body.oversized) return failure("Mistral search response exceeded byte bound");
      return mapMistralSearchResponse(JSON.parse(new TextDecoder().decode(body.bytes)));
    } finally { detach(); }
  } catch {
    return failure(linked.signal.aborted ? "Mistral search cancelled or timed out" : "Mistral search request failed");
  } finally { leave(); linked.cleanup(); }
}
