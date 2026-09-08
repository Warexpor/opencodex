/**
 * Anthropic extended-thinking signature round-trip through Codex's `encrypted_content` slot.
 *
 * Anthropic requires the previous assistant turn's `thinking`/`redacted_thinking` blocks to be
 * replayed VERBATIM (with their signatures) while extended thinking is enabled; a signature-less
 * replay 400s ("Expected `thinking` or `redacted_thinking`, but found `tool_use`"). Codex round-trips
 * whatever `encrypted_content` a reasoning output item carries (include: reasoning.encrypted_content
 * is set whenever reasoning is on — codex-rs client.rs), so the proxy smuggles the real Anthropic
 * signature (and any redacted blocks) inside a transparent `ocxr1:` + base64(JSON) envelope.
 *
 * Native OpenAI-encrypted blobs (no ocxr1 prefix) are left untouched by the decoder, and the
 * passthrough scrub strips ocxr1 envelopes before native forwarding.
 *
 * Claude Code Desktop → muse-spark (and other Responses reasoning models): the same envelope also
 * carries a `wire` snapshot of the Responses `reasoning` item so inbound can restore it. Dropping
 * thinking on replay left only tools+instructions (~3.5k) in Meta's prefix cache; restoring the
 * wire item lets history join the cached prefix the way native Grok/Responses clients already do.
 */

export const OCX_REASONING_PREFIX = "ocxr1:";

/** Responses reasoning item fields needed for exact multi-turn prefix replay. */
export interface ReasoningWireSnapshot {
  id?: string;
  summary?: unknown;
  content?: unknown;
  encrypted_content?: string;
}

export interface ReasoningEnvelope {
  /** Anthropic thinking-block signature (signature_delta), if captured. */
  sig?: string;
  /** Raw redacted_thinking block data payloads, order preserved. */
  red?: string[];
  /**
   * Hidden thinking text (hideThinkingSummary providers): the signature signs this exact text,
   * so replay needs it even though the visible summary was suppressed.
   */
  txt?: string;
  /**
   * Kiro `reasoningContentEvent.redactedContent`: a KMS-encrypted reasoning blob that is opaque to
   * the proxy. Kiro's own CLI replays it on the matching `assistantResponseMessage` to preserve
   * model reasoning across turns, so it round-trips here the same way a signature does.
   */
  krc?: string;
  /**
   * Responses `reasoning` item snapshot for Claude inbound replay onto routed /responses backends.
   * Prefer this over rebuilding from visible thinking text alone.
   */
  wire?: ReasoningWireSnapshot;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function envelopeHasPayload(envelope: ReasoningEnvelope): boolean {
  return !!(envelope.sig || envelope.red || envelope.txt || envelope.krc || envelope.wire);
}

export function encodeReasoningEnvelope(envelope: ReasoningEnvelope): string {
  return OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(envelope), "utf-8").toString("base64");
}

/** Decode an ocxr1 envelope; returns null for native (OpenAI-encrypted) blobs or garbage. */
export function decodeReasoningEnvelope(encryptedContent: string): ReasoningEnvelope | null {
  if (!encryptedContent.startsWith(OCX_REASONING_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encryptedContent.slice(OCX_REASONING_PREFIX.length), "base64").toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as {
      sig?: unknown;
      red?: unknown;
      txt?: unknown;
      krc?: unknown;
      wire?: unknown;
    };
    const envelope: ReasoningEnvelope = {};
    if (typeof obj.sig === "string") envelope.sig = obj.sig;
    if (Array.isArray(obj.red)) {
      const red = obj.red.filter((r): r is string => typeof r === "string");
      if (red.length > 0) envelope.red = red;
    }
    if (typeof obj.txt === "string" && obj.txt.length > 0) envelope.txt = obj.txt;
    if (typeof obj.krc === "string" && obj.krc.length > 0) envelope.krc = obj.krc;
    if (isNonEmptyRecord(obj.wire)) {
      const wire: ReasoningWireSnapshot = {};
      if (typeof obj.wire.id === "string" && obj.wire.id.length > 0) wire.id = obj.wire.id;
      if (obj.wire.summary !== undefined) wire.summary = obj.wire.summary;
      if (obj.wire.content !== undefined) wire.content = obj.wire.content;
      if (typeof obj.wire.encrypted_content === "string" && obj.wire.encrypted_content.length > 0
        && !obj.wire.encrypted_content.startsWith(OCX_REASONING_PREFIX)) {
        wire.encrypted_content = obj.wire.encrypted_content;
      }
      if (wire.id || wire.summary !== undefined || wire.content !== undefined || wire.encrypted_content) {
        envelope.wire = wire;
      }
    }
    return envelopeHasPayload(envelope) ? envelope : null;
  } catch {
    return null;
  }
}

/**
 * Build a Claude thinking-block signature that can restore the Responses reasoning item on
 * the next turn. Prefer the upstream item's arrays/blob; fall back to visible text as summary.
 */
export function encodeResponsesReasoningSignature(
  item: Record<string, unknown>,
  fallbackText?: string,
): string {
  const wire: ReasoningWireSnapshot = {};
  if (typeof item.id === "string" && item.id.length > 0) wire.id = item.id;
  if (Array.isArray(item.summary)) wire.summary = item.summary;
  if (Array.isArray(item.content)) wire.content = item.content;
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
    && !item.encrypted_content.startsWith(OCX_REASONING_PREFIX)) {
    wire.encrypted_content = item.encrypted_content;
  }
  const envelope: ReasoningEnvelope = {};
  if (wire.id || wire.summary !== undefined || wire.content !== undefined || wire.encrypted_content) {
    envelope.wire = wire;
  }
  const text = typeof fallbackText === "string" ? fallbackText : "";
  if (text.length > 0) envelope.txt = text;
  if (!envelope.wire && text.length > 0) {
    envelope.wire = { summary: [{ type: "summary_text", text }] };
  }
  if (!envelopeHasPayload(envelope)) {
    envelope.txt = "";
    envelope.wire = { summary: [] };
  }
  return encodeReasoningEnvelope(envelope);
}

/**
 * Restore a Responses `reasoning` input item from a Claude `thinking` / `redacted_thinking` block.
 * Returns null when there is nothing usable to replay.
 */
export function responsesReasoningFromThinkingBlock(
  block: Record<string, unknown>,
): Record<string, unknown> | null {
  const signature = typeof block.signature === "string" ? block.signature : "";
  const thinking = typeof block.thinking === "string" ? block.thinking
    : typeof block.data === "string" ? block.data
    : "";
  const env = signature.length > 0 ? decodeReasoningEnvelope(signature) : null;
  if (env?.wire) {
    const item: Record<string, unknown> = { type: "reasoning" };
    if (env.wire.id) item.id = env.wire.id;
    if (env.wire.summary !== undefined) item.summary = env.wire.summary;
    if (env.wire.content !== undefined) item.content = env.wire.content;
    if (typeof env.wire.encrypted_content === "string") item.encrypted_content = env.wire.encrypted_content;
    if (item.summary !== undefined || item.content !== undefined || item.encrypted_content !== undefined) {
      return item;
    }
  }
  const text = (env?.txt && env.txt.length > 0) ? env.txt : thinking;
  if (!text) return null;
  return {
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
  };
}
