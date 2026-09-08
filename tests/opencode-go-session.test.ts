import { describe, expect, it } from "bun:test";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import {
  OPENCODE_GO_SESSION_HEADER,
  attachOpenCodeGoSessionHeader,
  isOpenCodeGoDestination,
  resolveOpenCodeGoSessionId,
  sanitizeOpenCodeGoSessionId,
} from "../src/providers/opencode-go-session";

function parsed(partial?: Partial<OcxParsedRequest>): OcxParsedRequest {
  return {
    modelId: "muse-spark-1.3-contributor",
    stream: true,
    context: {
      messages: [
        {
          role: "user",
          content: "hey there, create a branch",
          timestamp: 1,
        },
      ],
    },
    options: {},
    ...partial,
  };
}

function goProvider(extra?: Partial<OcxProviderConfig>): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authMode: "key",
    apiKey: "sk-test",
    ...extra,
  } as OcxProviderConfig;
}

describe("opencode-go session affinity", () => {
  it("detects Console Go destinations only", () => {
    expect(isOpenCodeGoDestination({ baseUrl: "https://opencode.ai/zen/go/v1" })).toBe(true);
    expect(isOpenCodeGoDestination({ baseUrl: "https://opencode.ai/zen/go/v1/" })).toBe(true);
    expect(isOpenCodeGoDestination({ baseUrl: "https://opencode.ai/zen/v1" })).toBe(false);
    expect(isOpenCodeGoDestination({ baseUrl: "http://127.0.0.1:10100/v1" })).toBe(false);
  });

  it("sanitizes and hashes overlong ids", () => {
    expect(sanitizeOpenCodeGoSessionId("  abc  ")).toBe("abc");
    expect(sanitizeOpenCodeGoSessionId("a\nb")).toBeUndefined();
    const long = "x".repeat(200);
    const hashed = sanitizeOpenCodeGoSessionId(long);
    expect(hashed).toBeDefined();
    expect(hashed!.length).toBe(64);
    expect(hashed).not.toBe(long);
  });

  it("prefers thread identity over first-user text", () => {
    const id = resolveOpenCodeGoSessionId(
      parsed({ _clientThreadId: "thread-123" }),
    );
    expect(id).toBe("thread-123");
  });

  it("falls back to a stable hash of the first user message", () => {
    const a = resolveOpenCodeGoSessionId(parsed());
    const b = resolveOpenCodeGoSessionId(parsed());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("attaches x-opencode-session for Go and preserves caller overrides", () => {
    const headers: Record<string, string> = { Authorization: "Bearer sk" };
    attachOpenCodeGoSessionHeader(goProvider(), headers, parsed({ _clientThreadId: "sess-1" }));
    expect(headers[OPENCODE_GO_SESSION_HEADER]).toBe("sess-1");

    const overridden: Record<string, string> = {
      Authorization: "Bearer sk",
      "X-OpenCode-Session": "caller-fixed",
    };
    attachOpenCodeGoSessionHeader(goProvider(), overridden, parsed({ _clientThreadId: "sess-2" }));
    expect(overridden["X-OpenCode-Session"]).toBe("caller-fixed");
    expect(overridden[OPENCODE_GO_SESSION_HEADER]).toBeUndefined();
  });

  it("does not attach the header for non-Go providers", () => {
    const headers: Record<string, string> = {};
    attachOpenCodeGoSessionHeader(
      { baseUrl: "https://opencode.ai/zen/v1" } as OcxProviderConfig,
      headers,
      parsed(),
    );
    expect(headers[OPENCODE_GO_SESSION_HEADER]).toBeUndefined();
  });
});
