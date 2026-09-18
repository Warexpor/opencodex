import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OcxProviderConfig } from "../types";
import { PROVIDER_REGISTRY, registryEntryForProviderDestination } from "./registry";

/** Zen free-tier path: same identity headers the OpenCode CLI sends to unlock free models. */
export const OPENCODE_ZEN_PROVIDER_IDS = new Set(["opencode-zen", "opencode-free"]);

/**
 * Lowest User-Agent Console's free-tier gate accepts (anomalyco/opencode#49433).
 * A bare `opencode` or `0.0.0-<channel>` stamp is rejected.
 */
export const OPENCODE_ZEN_USER_AGENT = "opencode/1.18.31";

export const OPENCODE_ZEN_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_ZEN_REQUEST_HEADER = "x-opencode-request";
export const OPENCODE_ZEN_PROJECT_HEADER = "x-opencode-project";
export const OPENCODE_ZEN_CLIENT_HEADER = "x-opencode-client";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OC_ID = /^(?:ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const VERSIONED_UA = /^opencode\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/i;

type ToolRecord = Record<string, unknown>;

let idLastMs = 0;
let idCounter = 0;
const sessionByKey = new Map<string, string>();
let officialChatTools: ToolRecord[] | undefined;
let officialResponsesTools: ToolRecord[] | undefined;

function normalizedEndpoint(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function headerEntry(
  headers: Record<string, string>,
  name: string,
): { key?: string; value?: string } {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return { key, value: key ? headers[key] : undefined };
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find(k => k.toLowerCase() === name);
  if (existing && existing !== name) delete headers[existing];
  headers[name] = value;
}

function userAgentAcceptsFreeTier(value: string | undefined): boolean {
  if (!value) return false;
  const match = VERSIONED_UA.exec(value.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 1) return major > 1;
  if (minor !== 18) return minor > 18;
  return true;
}

/** OpenCode `Identifier.create`: `prefix_` + 6-byte timestamp hex + 14 base62. */
function createOpenCodeId(prefix: "ses" | "msg"): string {
  const now = Date.now();
  if (now !== idLastMs) {
    idLastMs = now;
    idCounter = 0;
  }
  idCounter += 1;
  const packed = (BigInt(now) * 0x1000n + BigInt(idCounter)) & ((1n << 48n) - 1n);
  const hex = packed.toString(16).padStart(12, "0");
  const bytes = randomBytes(14);
  let tail = "";
  for (let i = 0; i < 14; i++) tail += B62[bytes[i]! % 62]!;
  return `${prefix}_${hex}${tail}`;
}

export function isOpenCodeZenIdentifier(value: string, prefix: "ses" | "msg"): boolean {
  return OC_ID.test(value) && value.startsWith(`${prefix}_`);
}

/**
 * Free-tier model ids are discovered live. The gate is the `-free` suffix plus
 * `big-pickle`, which Console treats as free without that suffix.
 */
export function isOpenCodeZenFreeTierModel(modelId: string): boolean {
  const bare = modelId.trim().toLowerCase().split("/").pop() ?? "";
  return bare === "big-pickle" || bare.endsWith("-free") || bare.includes("-free-");
}

function loadOfficialChatTools(): ToolRecord[] {
  if (officialChatTools) return officialChatTools;
  const raw = JSON.parse(readFileSync(new URL("./opencode-zen-builtin-tools.json", import.meta.url), "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("OpenCode Zen builtin tools are missing");
  }
  officialChatTools = raw.filter((tool): tool is ToolRecord =>
    tool !== null && typeof tool === "object" && !Array.isArray(tool));
  return officialChatTools;
}

function toolName(tool: ToolRecord): string {
  const fn = tool.function;
  if (fn !== null && typeof fn === "object" && !Array.isArray(fn)) {
    const name = (fn as ToolRecord).name;
    if (typeof name === "string") return name;
  }
  return typeof tool.name === "string" ? tool.name : "";
}

function asResponsesTool(tool: ToolRecord): ToolRecord {
  const fn = tool.function !== null && typeof tool.function === "object" && !Array.isArray(tool.function)
    ? tool.function as ToolRecord
    : tool;
  const out: ToolRecord = {
    type: "function",
    name: fn.name,
    description: typeof fn.description === "string" ? fn.description : "",
    parameters: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
  };
  if ("strict" in tool) out.strict = tool.strict;
  else if ("strict" in fn) out.strict = fn.strict;
  return out;
}

function loadOfficialResponsesTools(): ToolRecord[] {
  if (!officialResponsesTools) officialResponsesTools = loadOfficialChatTools().map(asResponsesTool);
  return officialResponsesTools;
}

function mergeTools(existing: unknown, official: ToolRecord[]): ToolRecord[] {
  const current = Array.isArray(existing)
    ? existing.filter((tool): tool is ToolRecord => tool !== null && typeof tool === "object" && !Array.isArray(tool))
    : [];
  const officialNames = new Set(official.map(toolName));
  const extras = current.filter(tool => !officialNames.has(toolName(tool)));
  return [...official, ...extras];
}

/**
 * Console's free-tier gate (2026-09-18) rejects a chat/responses body that is
 * not streaming or that omits OpenCode's builtin tools. Extra harness tools stay.
 * Non-streaming Chat clients still receive JSON: the native and bridged paths fold SSE.
 */
export function applyOpenCodeZenFreeTierBody(
  body: Record<string, unknown>,
  wire: "chat" | "responses",
  modelId: string,
): Record<string, unknown> {
  if (!isOpenCodeZenFreeTierModel(modelId)) return body;
  const official = wire === "responses" ? loadOfficialResponsesTools() : loadOfficialChatTools();
  return {
    ...body,
    tools: mergeTools(body.tools, official),
    tool_choice: body.tool_choice === undefined || body.tool_choice === null ? "auto" : body.tool_choice,
    stream: true,
  };
}

/**
 * Stable per-credential session id (`ses_…`). Keyless free traffic shares one
 * anonymous lane. The id is minted in Identifier.create form and reused for the
 * process lifetime; a hash cannot carry a timestamp Console will accept.
 */
export function deriveOpenCodeZenSessionId(apiKey: string | undefined): string {
  const material = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : "anonymous";
  const key = createHash("sha256")
    .update("opencodex/opencode-zen/session/v2\0")
    .update(material)
    .digest("hex");
  const cached = sessionByKey.get(key);
  if (cached && isOpenCodeZenIdentifier(cached, "ses")) return cached;
  const sid = createOpenCodeId("ses");
  sessionByKey.set(key, sid);
  return sid;
}

export function newOpenCodeZenRequestId(): string {
  return createOpenCodeId("msg");
}

export function isOpenCodeZenProvider(provider: OcxProviderConfig): boolean {
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  const byAdapter = registryEntryForProviderDestination(provider)?.id;
  if (typeof byAdapter === "string" && OPENCODE_ZEN_PROVIDER_IDS.has(byAdapter)) return true;
  // Muse settles onto openai-responses after the chat registry match. The
  // endpoint, not the settled adapter, is what makes this Zen.
  if (typeof provider.baseUrl !== "string" || !provider.baseUrl) return false;
  const endpoint = normalizedEndpoint(provider.baseUrl);
  return PROVIDER_REGISTRY.some(entry =>
    OPENCODE_ZEN_PROVIDER_IDS.has(entry.id)
    && entry.authKind === "key"
    && normalizedEndpoint(entry.baseUrl) === endpoint);
}

/**
 * Stamp CLI free-tier identity onto Zen/free upstream calls.
 * Static registry headers carry User-Agent + x-opencode-client=cli; this adds
 * the per-key session and per-call request ids, upgrades a saved unversioned
 * `opencode` user agent, and replaces a session/request id that is not
 * Identifier.create form. An explicit `opencode/<semver >= 1.18.0>` and a
 * valid inbound session still win. A non-`opencode/…` user agent is an
 * operator override and is left alone.
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

  const userAgent = headerEntry(headers, "user-agent");
  const userAgentValue = userAgent.value?.trim();
  const opencodeFamily = userAgentValue === undefined
    || userAgentValue === "opencode"
    || /^opencode\//i.test(userAgentValue);
  if (opencodeFamily && !userAgentAcceptsFreeTier(userAgentValue)) {
    setHeader(headers, "User-Agent", OPENCODE_ZEN_USER_AGENT);
    changed = true;
  }

  const session = headerEntry(headers, OPENCODE_ZEN_SESSION_HEADER);
  if (!session.value || !isOpenCodeZenIdentifier(session.value, "ses")) {
    setHeader(headers, OPENCODE_ZEN_SESSION_HEADER, deriveOpenCodeZenSessionId(provider.apiKey));
    changed = true;
  }
  const request = headerEntry(headers, OPENCODE_ZEN_REQUEST_HEADER);
  if (!request.value || !isOpenCodeZenIdentifier(request.value, "msg")) {
    setHeader(headers, OPENCODE_ZEN_REQUEST_HEADER, newOpenCodeZenRequestId());
    changed = true;
  }
  if (!headerEntry(headers, OPENCODE_ZEN_PROJECT_HEADER).value) {
    setHeader(headers, OPENCODE_ZEN_PROJECT_HEADER, "global");
    changed = true;
  }

  return changed ? { ...provider, headers } : provider;
}
