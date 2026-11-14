import { afterEach, expect, test } from "bun:test";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { mapMistralSearchResponse, runMistralWebSearch } from "../../src/web-search/mistral-executor";
import { planWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../src/web-search";
import { planVisionSidecar, shouldResolveOpenAiVisionSidecar } from "../../src/vision/plan";
import { providerHelpersConfigError, providerVisionConfig } from "../../src/sidecar/provider-policy";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import { providerManagementConfigError } from "../../src/server/auth-cors";

const provider: OcxProviderConfig = { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-only",
  noVisionModels: ["text-model"], helpers: { search: "native", searchModel: "search-model", vision: "native", visionModel: "image-model" } };
const config = (): OcxConfig => ({ port: 12345, providers: { renamed: { ...provider } },
  webSearchSidecar: { backend: "openai", enabled: false }, visionSidecar: { backend: "openai", enabled: false } } as OcxConfig);
const parsed = (): OcxParsedRequest => ({ model: "renamed/text-model", stream: false, options: {}, _webSearch: { type: "web_search" },
  context: { messages: [{ role: "user", content: [{ type: "image", url: "data:image/png;base64,aA==", mimeType: "image/png" }] }], tools: [] } } as unknown as OcxParsedRequest);
const payload = () => ({ outputs: [{ type: "tool.execution", name: "web_search" }, { type: "message.output", role: "assistant", content: [
  { type: "text", text: "Current answer" }, { type: "tool_reference", tool: "web_search", url: "https://example.com/source", title: "Source" },
  { type: "tool_reference", tool: "web_search", url: "https://example.com/source" },
] }] });
const settings = { model: "search-model", reasoning: "low", timeoutMs: 2000, describeImages: false };
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("provider policy overrides disabled globals without changing the saved settings or requiring GPT", () => {
  const cfg = config(); const before = JSON.stringify(cfg);
  expect(shouldResolveOpenAiWebSearchSidecar(cfg, parsed(), false, provider)).toBe(false);
  const search = planWebSearch(cfg, parsed(), false, provider, "text-model", undefined, { providerName: "renamed" });
  expect(search?.backend).toBe("mistral"); expect(search?.forwardSidecar).toBeUndefined();
  expect(search?.mistralSidecar?.providerName).toBe("renamed");
  expect(shouldResolveOpenAiVisionSidecar(cfg, provider, "text-model", parsed(), "renamed")).toBe(false);
  const vision = planVisionSidecar(cfg, provider, "text-model", parsed(), undefined, { providerName: "renamed" });
  expect(vision?.backend).toBe("routed"); expect(vision?.routedModel).toBe("renamed/image-model");
  expect(JSON.stringify(cfg)).toBe(before);
});

test("absent and inherited policies retain legacy admission; disabled helpers stay disabled", () => {
  const cfg = config(); cfg.webSearchSidecar = { backend: "openai" };
  expect(shouldResolveOpenAiWebSearchSidecar(cfg, parsed(), false, { ...provider, helpers: undefined })).toBe(true);
  expect(shouldResolveOpenAiWebSearchSidecar(cfg, parsed(), false, { ...provider, helpers: { search: "inherit" } })).toBe(true);
  const disabled = { ...provider, helpers: { search: "disabled", vision: "disabled" } } as OcxProviderConfig;
  expect(planWebSearch(cfg, parsed(), false, disabled, "text-model")).toBeUndefined();
  expect(planVisionSidecar(cfg, disabled, "text-model", parsed(), undefined, { providerName: "renamed" })).toBeUndefined();
  expect(providerVisionConfig(cfg, { ...provider, helpers: undefined })).toBe(cfg);
});

test("invalid native vision fails instead of falling back to OpenAI", () => {
  const cfg = config(); const blind = { ...provider, helpers: { vision: "native", visionModel: "text-model" } } as OcxProviderConfig;
  expect(shouldResolveOpenAiVisionSidecar(cfg, blind, "text-model", parsed(), "renamed")).toBe(false);
  expect(() => planVisionSidecar(cfg, blind, "text-model", parsed(), undefined, { providerName: "renamed" })).toThrow("cannot accept images");
});

test("policy validates destination, model slugs and persisted editor data", () => {
  expect(providerConfigSchema.safeParse(provider).success).toBe(true);
  expect(providerManagementConfigError("renamed", provider)).toBeNull();
  expect(providerHelpersConfigError({ search: "native" }, provider)).toContain("searchModel");
  expect(providerConfigSchema.safeParse({ ...provider, helpers: { vision: "native" } }).success).toBe(false);
  expect(providerHelpersConfigError({ vision: "native", visionModel: "openai/gpt" }, provider)).toContain("bare");
  expect(providerHelpersConfigError(provider.helpers, { ...provider, baseUrl: "https://other.example/v1" })).toContain("canonical");
  expect(providerHelpersConfigError({ search: "auto" }, provider)).toContain("selection");
  expect(providerHelpersConfigError({ secret: "not-echoed" }, provider)).toContain("unknown");
});

test("mapper preserves citations and rejects memory-only, uncited and empty answers", () => {
  expect(mapMistralSearchResponse(payload())).toEqual({ text: "Current answer", sources: [{ url: "https://example.com/source", title: "Source" }] });
  const memory = payload(); memory.outputs.shift(); expect(mapMistralSearchResponse(memory).error).toContain("did not execute");
  const empty = payload(); (empty.outputs[1]!.content![0] as { text: string }).text = "";
  expect(mapMistralSearchResponse(empty).error).toContain("no answer");
  expect(mapMistralSearchResponse(null).error).toContain("invalid");
  const unsafe = payload(); (unsafe.outputs[1]!.content![1] as { url: string }).url = "javascript:alert(1)";
  unsafe.outputs[1]!.content!.pop(); expect(mapMistralSearchResponse(unsafe).error).toContain("no web citations");
});

test("executor sends only the query with the selected Mistral key, no history or GPT headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json(payload()); }) as typeof fetch;
  const cfg = config(); const out = await runMistralWebSearch("latest fixture news", { providerName: "renamed", provider: cfg.providers.renamed!, config: cfg }, settings);
  expect(out.error).toBeUndefined(); expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/conversations");
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer fixture-mistral-only");
  expect(new Headers(calls[0]!.init?.headers).get("chatgpt-account-id")).toBeNull();
  expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ inputs: "latest fixture news", store: false, model: "search-model", tools: [{ type: "web_search" }] });
  expect(calls[0]!.init?.redirect).toBe("manual");
});

for (const status of [302, 401, 403, 429, 500]) test(`HTTP ${status} is visible without retries, GPT fallback or leaked refusal bodies`, async () => {
  let sends = 0; globalThis.fetch = (async () => { sends++; return new Response("fixture-mistral-only private body", { status }); }) as typeof fetch;
  const cfg = config(); const out = await runMistralWebSearch("q", { providerName: "renamed", provider: cfg.providers.renamed!, config: cfg }, settings);
  expect(out.error).toBe(`Mistral search HTTP ${status}`); expect(sends).toBe(1);
});

test("missing/disabled keys, cancellation and malformed bodies do not call another provider", async () => {
  let sends = 0; globalThis.fetch = (async () => { sends++; return new Response("bad json"); }) as typeof fetch;
  const cfg = config(); const sidecar = { providerName: "renamed", provider: cfg.providers.renamed!, config: cfg };
  cfg.providers.renamed!.apiKey = "";
  expect((await runMistralWebSearch("q", sidecar, settings)).error).toContain("credential"); expect(sends).toBe(0);
  cfg.providers.renamed!.apiKey = "fixture-mistral-only";
  expect((await runMistralWebSearch("q", sidecar, settings, AbortSignal.abort())).error).toContain("cancelled"); expect(sends).toBe(0);
  expect((await runMistralWebSearch("q", sidecar, settings)).error).toContain("failed"); expect(sends).toBe(1);
});

test("real Responses request runs Chat -> Mistral search -> Chat with no OpenAI provider or credential", async () => {
  const { handleResponses } = await import("../../src/server/responses/core");
  const { acquireOwnedSpendHome } = await import("../helpers/owned-spend-home");
  const release = acquireOwnedSpendHome();
  const calls: string[] = [];
  let completions = 0;
  const cfg = config();
  cfg.defaultProvider = "renamed";
  const routed = cfg.providers.renamed!;
  routed.models = ["text-model", "image-model"]; routed.liveModels = false;
  Object.assign(routed, { fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url); calls.push(target);
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-mistral-only");
    if (target.endsWith("/conversations")) return Response.json(payload());
    expect(target).toBe("https://api.mistral.ai/v1/chat/completions");
    completions++;
    if (completions === 2) expect(JSON.stringify(body)).toContain("Current answer");
    const deltas = completions === 1 ? [
      { delta: { tool_calls: [{ index: 0, id: "search-fixture", type: "function", function: { name: "web_search", arguments: '{"query":"latest fixture news"}' } }] }, finish_reason: null },
      { delta: {}, finish_reason: "tool_calls" },
    ] : [{ delta: { content: "The fixture answer is verified." }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
    return new Response(deltas.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  globalThis.fetch = (() => { throw new Error("unexpected global or GPT fetch"); }) as unknown as typeof fetch;
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "renamed/text-model", input: "Search current fixture news", stream: true, tools: [{ type: "web_search" }] }),
    }), cfg, { model: "", provider: "" });
    const body = await response.text();
    expect(response.status).toBe(200); expect(body).toContain("response.completed");
    expect(body).not.toContain("response.failed"); expect(body).toContain("The fixture answer is verified.");
    expect(calls).toEqual(["https://api.mistral.ai/v1/chat/completions", "https://api.mistral.ai/v1/conversations", "https://api.mistral.ai/v1/chat/completions"]);
  } finally { release(); }
});


test("serialized provider configuration retains helper settings across save and reload", async () => {
  const { saveConfig, loadConfig } = await import("../../src/config");
  const cfg = config(); saveConfig(cfg);
  expect(loadConfig().providers.renamed?.helpers).toEqual(provider.helpers);
  expect(loadConfig().visionSidecar).toEqual(cfg.visionSidecar);
  expect(loadConfig().webSearchSidecar).toEqual(cfg.webSearchSidecar);
});


test("helper spending admission fences credential changes before physical dispatch", async () => {
  let sends = 0; globalThis.fetch = (async () => { sends++; return Response.json(payload()); }) as typeof fetch;
  const cfg = config(); const sidecar = { providerName: "renamed", provider: cfg.providers.renamed!, config: cfg };
  const result = await runMistralWebSearch("q", sidecar, settings, undefined, async (_target, send) => {
    cfg.providers.renamed = { ...cfg.providers.renamed!, apiKey: "changed-fixture-key" };
    return send();
  });
  expect(result.error).toContain("failed"); expect(sends).toBe(0);
});


test("provider API PATCH and GET round-trip helpers, reject invalid writes and support reset", async () => {
  const { handleManagementAPI } = await import("../../src/server/management-api");
  const { ManagementRequest } = await import("../helpers/management-auth");
  const { catalogConvergenceFactory } = await import("../helpers/catalog-convergence");
  const { loadConfig, saveConfig } = await import("../../src/config");
  const cfg = config(); cfg.providers.renamed!.helpers = undefined; cfg.providers.renamed!.liveModels = false;
  saveConfig(cfg);
  const request = async (method: string, body?: unknown) => {
    const req = new ManagementRequest("http://127.0.0.1/api/providers?name=renamed", { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return handleManagementAPI(req, new URL(req.url), cfg, { createManagementConvergeCodex: catalogConvergenceFactory(() => {}) });
  };
  globalThis.fetch = (() => { throw new Error("management persistence must not fetch a provider"); }) as unknown as typeof fetch;
  const changed = await request("PATCH", { helpers: provider.helpers });
  expect(changed?.status).toBe(200);
  expect(loadConfig().providers.renamed?.helpers).toEqual(provider.helpers);
  const rows = await (await request("GET"))!.json() as Array<{ name: string; helpers?: unknown; apiKey?: string }>;
  expect(rows.find(row => row.name === "renamed")?.helpers).toEqual(provider.helpers);
  expect(rows[0]?.apiKey).toBeUndefined();
  const rejected = await request("PATCH", { helpers: { search: "native" } });
  expect(rejected?.status).toBe(400); expect(loadConfig().providers.renamed?.helpers).toEqual(provider.helpers);
  const reset = await request("PATCH", { helpers: null });
  expect(reset?.status).toBe(200); expect(loadConfig().providers.renamed?.helpers).toBeUndefined();
});
