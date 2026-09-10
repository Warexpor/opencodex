import { createHash, randomBytes } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

/** Zen free-tier path: same identity headers the OpenCode CLI sends to unlock free models. */
export const OPENCODE_ZEN_PROVIDER_IDS = new Set(["opencode-zen", "opencode-free"]);

export const OPENCODE_ZEN_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_ZEN_REQUEST_HEADER = "x-opencode-request";
export const OPENCODE_ZEN_PROJECT_HEADER = "x-opencode-project";
export const OPENCODE_ZEN_CLIENT_HEADER = "x-opencode-client";

const SESSION_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

function randomId(prefix: string, n = 24): string {
  const bytes = randomBytes(n);
  let out = prefix;
  for (let i = 0; i < n; i++) out += SESSION_ALPHABET[bytes[i]! % SESSION_ALPHABET.length]!;
  return out;
}

/**
 * Stable per-credential session id (`ses_…`). Keyless free traffic shares one
 * anonymous lane so Zen still sees a session without inventing per-process noise.
 */
export function deriveOpenCodeZenSessionId(apiKey: string | undefined): string {
  const material = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : "anonymous";
  const digest = createHash("sha256")
    .update("opencodex/opencode-zen/session/v1\0")
    .update(material)
    .digest("hex")
    .slice(0, 24);
  // Match the CLI alphabet: hex is a subset, then pad with a fixed suffix from the digest.
  return `ses_${digest}`;
}

export function newOpenCodeZenRequestId(): string {
  return randomId("msg_");
}

export function isOpenCodeZenProvider(provider: OcxProviderConfig): boolean {
  const id = registryEntryForProviderDestination(provider)?.id;
  return typeof id === "string" && OPENCODE_ZEN_PROVIDER_IDS.has(id);
}

/**
 * Stamp CLI free-tier identity onto Zen/free upstream calls.
 * Static registry headers already carry User-Agent + x-opencode-client=cli;
 * this adds the per-key session and per-call request ids the external Zen
 * gateway used to forge, and upgrades the legacy `desktop` client marker so
 * existing installs unlock free models without a manual header rewrite.
 * Explicit non-desktop client values (and inbound session/project/request)
 * still win.
 */
export function resolveOpenCodeZenTransport<T extends OcxProviderConfig>(provider: T): T {
  if (!isOpenCodeZenProvider(provider)) return provider;

  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  let changed = false;

  const clientKey = Object.keys(headers).find(k => k.toLowerCase() === OPENCODE_ZEN_CLIENT_HEADER);
  const clientVal = clientKey ? headers[clientKey] : undefined;
  if (clientVal === undefined || clientVal === "desktop") {
    if (clientKey && clientKey !== OPENCODE_ZEN_CLIENT_HEADER) delete headers[clientKey];
    headers[OPENCODE_ZEN_CLIENT_HEADER] = "cli";
    changed = true;
  }

  if (!hasHeaderCaseInsensitive(headers, OPENCODE_ZEN_SESSION_HEADER)) {
    headers[OPENCODE_ZEN_SESSION_HEADER] = deriveOpenCodeZenSessionId(provider.apiKey);
    changed = true;
  }
  if (!hasHeaderCaseInsensitive(headers, OPENCODE_ZEN_REQUEST_HEADER)) {
    headers[OPENCODE_ZEN_REQUEST_HEADER] = newOpenCodeZenRequestId();
    changed = true;
  }
  if (!hasHeaderCaseInsensitive(headers, OPENCODE_ZEN_PROJECT_HEADER)) {
    headers[OPENCODE_ZEN_PROJECT_HEADER] = "global";
    changed = true;
  }

  return changed ? { ...provider, headers } : provider;
}
