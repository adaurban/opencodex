import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { buildProviderPayload, buildProviderPostBody } from "../src/provider-payload";
import type { ProviderPayloadForm } from "../src/provider-payload";
import { providerSettingsDraftFromItem, providerSettingsDeltaPatch } from "../src/provider-workspace/target-drafts";
import { chooseOption, selectTrigger } from "./helpers/custom-select";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});


const item: WorkspaceItem = { name: "renamed-mistral", adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", helpers: { searchModel: "search-model", visionModel: "image-model" } };

test("Mistral helpers save with the provider through the existing Settings action", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div"); document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(container); root.render(<LanguageProvider><ProviderSettings item={item}
    onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }} /></LanguageProvider>); });
  const search = selectTrigger(container, 'button[role="combobox"][aria-label="Web search helper"]');
  await chooseOption(search, "native");
  const image = selectTrigger(container, 'button[role="combobox"][aria-label="Image helper"]');
  await chooseOption(image, "native");
  const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === "Save");
  expect(save).toBeTruthy(); await act(async () => { save!.click(); });
  expect(patches).toHaveLength(1);
  expect(patches[0]!.helpers).toEqual({ searchModel: "search-model", visionModel: "image-model", search: "native", vision: "native" });
});

test("helper drafts preserve independent target edits and omit untouched settings", () => {
  const baseline = providerSettingsDraftFromItem(item);
  const draft = { ...baseline, helpers: { ...baseline.helpers, search: "native" as const } };
  const saved = { ...item, note: "updated elsewhere" };
  const { patch } = providerSettingsDeltaPatch(draft, baseline, saved, item.baseUrl);
  expect(patch.helpers?.search).toBe("native"); expect(patch.note).toBeUndefined();
});
