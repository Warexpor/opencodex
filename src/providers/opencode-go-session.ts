import { createHash } from "node:crypto";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

/** OpenCode Go requires this sticky-routing header on every inference request. */
export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

const OPENCODE_GO_BASE_PATH = "/zen/go/v1";
const SESSION_ID_MAX_LEN = 128;

/**
 * True when the provider points at Console Go (`opencode.ai/zen/go/v1`), regardless of
 * which OpenAI-shaped adapter the request currently rides.
 */
export function isOpenCodeGoDestination(
  provider: Pick<OcxProviderConfig, "baseUrl">,
): boolean {
  try {
    const url = new URL(provider.baseUrl);
    if (url.hostname.toLowerCase() !== "opencode.ai") return false;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return path === OPENCODE_GO_BASE_PATH || path.endsWith(OPENCODE_GO_BASE_PATH);
  } catch {
    return false;
  }
}

function headerValueIgnoreCase(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  if (headers instanceof Headers) {
    const direct = headers.get(name)?.trim();
    if (direct) return direct;
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === want) {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Clamp / hash a client-supplied id into a Go-safe opaque session token. */
export function sanitizeOpenCodeGoSessionId(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  if (trimmed.length <= SESSION_ID_MAX_LEN) return trimmed;
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, SESSION_ID_MAX_LEN);
}

function firstUserText(parsed: OcxParsedRequest): string | undefined {
  for (const message of parsed.context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      const trimmed = message.content.trim();
      if (trimmed) return message.content;
      continue;
    }
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Resolve a stable conversation id for Go sticky routing.
 *
 * Prefer identities that survive compaction (thread headers / replay scope), then
 * content anchors, then a fresh UUID so the request is never rejected for a missing header.
 */
export function resolveOpenCodeGoSessionId(
  parsed: OcxParsedRequest,
  incomingHeaders?: Headers,
): string {
  const candidates: Array<string | undefined | null> = [
    headerValueIgnoreCase(incomingHeaders, OPENCODE_GO_SESSION_HEADER),
    parsed._clientThreadId,
    parsed._reasoningReplayScope?.clientThreadId,
    parsed._cursorClientThreadId,
    parsed._cursorConversationId,
    headerValueIgnoreCase(incomingHeaders, "x-codex-parent-thread-id"),
    headerValueIgnoreCase(incomingHeaders, "session_id"),
    headerValueIgnoreCase(incomingHeaders, "session-id"),
    headerValueIgnoreCase(incomingHeaders, "thread-id"),
    parsed.options.promptCacheKey,
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeOpenCodeGoSessionId(candidate);
    if (sanitized) return sanitized;
  }

  const userText = firstUserText(parsed);
  if (userText) {
    return createHash("sha256").update(`opencode-go:${userText}`, "utf8").digest("hex");
  }

  if (parsed.previousResponseId) {
    const fromPrevious = sanitizeOpenCodeGoSessionId(parsed.previousResponseId);
    if (fromPrevious) return fromPrevious;
  }

  return crypto.randomUUID();
}

/**
 * Attach `x-opencode-session` for Console Go destinations. Caller-supplied provider
 * headers win when they already set the header (any casing).
 */
export function attachOpenCodeGoSessionHeader(
  provider: Pick<OcxProviderConfig, "baseUrl" | "headers">,
  headers: Record<string, string>,
  parsed: OcxParsedRequest,
  incomingHeaders?: Headers,
): void {
  if (!isOpenCodeGoDestination(provider)) return;
  if (headerValueIgnoreCase(headers, OPENCODE_GO_SESSION_HEADER)) return;
  if (headerValueIgnoreCase(provider.headers, OPENCODE_GO_SESSION_HEADER)) return;

  headers[OPENCODE_GO_SESSION_HEADER] = resolveOpenCodeGoSessionId(parsed, incomingHeaders);
}
