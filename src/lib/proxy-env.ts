import { socks5Fetch } from "./socks5-fetch";

export const OUTBOUND_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
export const PROXY_ENV_KEYS = [...OUTBOUND_PROXY_ENV_KEYS, "NO_PROXY"] as const;

export type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvMap = Record<string, string | undefined>;
export type ProxyRoute =
  | { kind: "direct" }
  | { kind: "proxy"; proxy: string }
  | { kind: "fallback" };

export function normalizeProxyHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function noProxyMatches(
  url: URL,
  env: ProxyEnvMap = process.env,
): boolean {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  const hostname = normalizeProxyHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const rawEntry of raw.split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    entry = entry.replace(/^(?:https?|wss?):\/\//, "").split("/", 1)[0]!;

    let entryHost = entry;
    let entryPort = "";
    const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entryHost = bracketed[1]!;
      entryPort = bracketed[2] ?? "";
    } else if ((entry.match(/:/g)?.length ?? 0) === 1) {
      const separator = entry.lastIndexOf(":");
      const possiblePort = entry.slice(separator + 1);
      if (/^\d+$/.test(possiblePort)) {
        entryHost = entry.slice(0, separator);
        entryPort = possiblePort;
      }
    }
    if (entryPort && entryPort !== port) continue;
    entryHost = normalizeProxyHostname(entryHost.replace(/^\*?\./, ""));
    if (entryHost && (hostname === entryHost || hostname.endsWith(`.${entryHost}`))) return true;
  }
  return false;
}

export function resolveProxyRoute(
  url: URL,
  env: ProxyEnvMap = process.env,
): ProxyRoute {
  if (noProxyMatches(url, env)) return { kind: "direct" };
  const key = url.protocol === "https:" || url.protocol === "wss:"
    ? "HTTPS_PROXY"
    : "HTTP_PROXY";
  const proxy = [key, key.toLowerCase(), "ALL_PROXY", "all_proxy"]
    .map(candidate => env[candidate]?.trim())
    .find(Boolean);
  if (!proxy) return { kind: "direct" };
  try {
    const protocol = new URL(proxy).protocol;
    return protocol === "http:" || protocol === "https:"
      ? { kind: "proxy", proxy }
      : { kind: "fallback" };
  } catch {
    return { kind: "fallback" };
  }
}

export function proxyEnvPresent(
  key: ProxyEnvKey,
  env: ProxyEnvMap = process.env,
): boolean {
  return Boolean(env[key]?.trim() || env[key.toLowerCase()]?.trim());
}

export function outboundProxyConfigured(
  env: ProxyEnvMap = process.env,
): boolean {
  return OUTBOUND_PROXY_ENV_KEYS.some(key => proxyEnvPresent(key, env));
}

export function isSocks5ProxyUrl(proxy: string): boolean {
  return /^socks5h?:\/\//i.test(proxy.trim());
}

/** Only ALL_PROXY / all_proxy; first value that is socks5(h). */
export function socks5ProxyFromEnv(env: ProxyEnvMap = process.env): string | undefined {
  const candidates = [env.ALL_PROXY, env.all_proxy];
  return candidates.find(value => typeof value === "string" && isSocks5ProxyUrl(value));
}

export function configuredOutboundFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallback?: typeof globalThis.fetch,
): Promise<Response> {
  const base = fallback ?? (globalThis.fetch === installedFetch ? nativeFetch : globalThis.fetch);
  const proxy = socks5ProxyFromEnv();
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return base!(input, init);
  }
  if (proxy && (url.protocol === "http:" || url.protocol === "https:") && !noProxyMatches(url)) {
    return socks5Fetch(input, init, proxy);
  }
  return base!(input, init);
}

type FetchWithPreconnect = typeof globalThis.fetch & {
  preconnect?: typeof globalThis.fetch.preconnect;
};

let nativeFetch: FetchWithPreconnect | undefined;
let installedFetch: FetchWithPreconnect | undefined;

/** Install/uninstall globalThis.fetch wrapper when ALL_PROXY is socks5. Preserves .preconnect. */
export function configureSocks5Fetch(): void {
  if (globalThis.fetch !== installedFetch) {
    nativeFetch = globalThis.fetch as FetchWithPreconnect;
    installedFetch = undefined;
  }
  const proxy = socks5ProxyFromEnv();
  if (!proxy) {
    if (installedFetch && globalThis.fetch === installedFetch && nativeFetch) globalThis.fetch = nativeFetch;
    installedFetch = undefined;
    return;
  }
  if (installedFetch && globalThis.fetch === installedFetch) return;
  const base = nativeFetch ?? globalThis.fetch as FetchWithPreconnect;
  nativeFetch = base;
  const wrapped = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      return configuredOutboundFetch(input, init, base);
    },
    { preconnect: base.preconnect?.bind(base) },
  ) as FetchWithPreconnect;
  installedFetch = wrapped;
  globalThis.fetch = wrapped;
}

/**
 * The proxy URL that Bun's fetch will actually use for `url`, or null when none applies.
 *
 * Bun selects by scheme: `HTTPS_PROXY` for `https:` targets, `HTTP_PROXY` for `http:`.
 * `ALL_PROXY` is deliberately not consulted here — fetch does not honour it, so a caller
 * that needs "this request will ride the proxy" as a precondition must not count it.
 * Presence of *some* proxy variable (`outboundProxyConfigured`) is not that guarantee.
 */
export function effectiveProxyFor(
  url: URL,
  env: ProxyEnvMap = process.env,
): string | null {
  const key: ProxyEnvKey | null = url.protocol === "https:"
    ? "HTTPS_PROXY"
    : url.protocol === "http:"
      ? "HTTP_PROXY"
      : null;
  if (!key) return null;
  const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
  return value ? value : null;
}
