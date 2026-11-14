/** Match the supported key-auth Chat destination, including one optional trailing slash. */
export function isCanonicalMistralChat(
  provider: { adapter: string; authMode?: string; baseUrl: string },
): boolean {
  if (provider.adapter !== "openai-chat" || (provider.authMode !== undefined && provider.authMode !== "key")) return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === "https://api.mistral.ai" && /^\/v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
