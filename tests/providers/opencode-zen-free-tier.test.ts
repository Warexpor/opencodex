import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { providerConfigSeed } from "../../src/providers/derive";
import {
  applyOpenCodeZenFreeTierBody,
  deriveOpenCodeZenSessionId,
  isOpenCodeZenIdentifier,
  OPENCODE_ZEN_USER_AGENT,
  resolveOpenCodeZenTransport,
} from "../../src/providers/opencode-zen-transport";
import { PROVIDER_REGISTRY, getProviderRegistryEntry } from "../../src/providers/registry";
import { parseRequest } from "../../src/responses/parser";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

describe("opencode zen free-tier path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("opencode-zen and opencode-free stamp CLI identity statically", () => {
    for (const id of ["opencode-zen", "opencode-free"] as const) {
      const entry = PROVIDER_REGISTRY.find(e => e.id === id);
      expect(entry?.staticHeaders?.["User-Agent"]).toBe(OPENCODE_ZEN_USER_AGENT);
      expect(entry?.staticHeaders?.["x-opencode-client"]).toBe("cli");
      expect(entry?.modelWireDefaults?.["muse-spark-1.3-contributor-free"]).toBe("openai-responses");
      expect(entry?.modelDefaultReasoningEfforts?.["muse-spark-1.3-contributor-free"]).toBe("minimal");
    }
  });

  test("session id is stable per api key and request id is unique", () => {
    const a = deriveOpenCodeZenSessionId("key-a");
    const b = deriveOpenCodeZenSessionId("key-a");
    const c = deriveOpenCodeZenSessionId("key-b");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("ses_")).toBe(true);
    expect(isOpenCodeZenIdentifier(a, "ses")).toBe(true);

    const entry = getProviderRegistryEntry("opencode-zen")!;
    const base = { ...providerConfigSeed(entry), apiKey: "key-a" };
    const once = resolveOpenCodeZenTransport(base);
    const twice = resolveOpenCodeZenTransport(base);
    expect(once.headers?.["x-opencode-session"]).toBe(a);
    expect(twice.headers?.["x-opencode-session"]).toBe(a);
    expect(isOpenCodeZenIdentifier(once.headers?.["x-opencode-request"] ?? "", "msg")).toBe(true);
    expect(once.headers?.["x-opencode-request"]).not.toBe(twice.headers?.["x-opencode-request"]);
    expect(once.headers?.["x-opencode-project"]).toBe("global");
    expect(once.headers?.["User-Agent"]).toBe(OPENCODE_ZEN_USER_AGENT);
  });

  test("legacy desktop client marker is upgraded to cli at settle time", () => {
    const entry = getProviderRegistryEntry("opencode-free")!;
    const provider = resolveOpenCodeZenTransport({
      ...providerConfigSeed(entry),
      headers: { "x-opencode-client": "desktop", "User-Agent": "opencode" },
    });
    expect(provider.headers?.["x-opencode-client"]).toBe("cli");
    expect(provider.headers?.["User-Agent"]).toBe(OPENCODE_ZEN_USER_AGENT);
  });

  test("a versioned OpenCode user agent at or above 1.18.0 is left alone", () => {
    const entry = getProviderRegistryEntry("opencode-free")!;
    const provider = resolveOpenCodeZenTransport({
      ...providerConfigSeed(entry),
      headers: { "User-Agent": "opencode/1.18.4" },
    });
    expect(provider.headers?.["User-Agent"]).toBe("opencode/1.18.4");
  });

  test("an invalid inbound session id is replaced with Identifier.create form", () => {
    const entry = getProviderRegistryEntry("opencode-zen")!;
    const kept = deriveOpenCodeZenSessionId("keep-session");
    const valid = resolveOpenCodeZenTransport({
      ...providerConfigSeed(entry),
      headers: { "x-opencode-session": kept },
    });
    expect(valid.headers?.["x-opencode-session"]).toBe(kept);

    const replaced = resolveOpenCodeZenTransport({
      ...providerConfigSeed(entry),
      apiKey: "replace-session",
      headers: { "x-opencode-session": `ses_${"ab".repeat(12)}` },
    });
    const session = replaced.headers?.["x-opencode-session"] ?? "";
    expect(session).not.toBe(`ses_${"ab".repeat(12)}`);
    expect(isOpenCodeZenIdentifier(session, "ses")).toBe(true);
  });

  test("explicit non-desktop client overrides survive", () => {
    const entry = getProviderRegistryEntry("opencode-free")!;
    const provider = resolveOpenCodeZenTransport({
      ...providerConfigSeed(entry),
      headers: { "x-opencode-client": "custom-harness" },
    });
    expect(provider.headers?.["x-opencode-client"]).toBe("custom-harness");
  });

  test("muse-spark free models settle on openai-responses for zen and free", () => {
    for (const id of ["opencode-zen", "opencode-free"] as const) {
      const entry = getProviderRegistryEntry(id)!;
      const provider = providerConfigSeed(entry);
      const settled = resolveWireProtocolOverride(id, "muse-spark-1.3-contributor-free", provider, "chat");
      expect(settled.adapter).toBe("openai-responses");
    }
  });

  test("muse default reasoning.effort=minimal is stamped when omitted", () => {
    const entry = getProviderRegistryEntry("opencode-zen")!;
    const provider = {
      ...providerConfigSeed(entry),
      apiKey: "test-key",
      adapter: "openai-responses" as const,
    };
    const parsed = parseRequest({
      model: "muse-spark-1.3-contributor-free",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 64,
    });
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
    const req = adapter.buildRequest(parsed);
    const body = JSON.parse(String(req.body)) as {
      reasoning?: { effort?: string };
      stream?: boolean;
      tools?: Array<{ name?: string }>;
    };
    expect(body.reasoning?.effort).toBe("minimal");
    expect(body.stream).toBe(true);
    expect(body.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["bash", "grep", "write"]));
    expect(req.url).toBe("https://opencode.ai/zen/v1/responses");
  });

  test("chat completions settle stamps zen session/request headers on the wire", async () => {
    const entry = getProviderRegistryEntry("opencode-zen")!;
    const provider = { ...providerConfigSeed(entry), apiKey: "wire-key" };
    const config = {
      providers: { "opencode-zen": provider },
    } as unknown as OcxConfig;

    let seen: Headers | undefined;
    let seenBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      seenBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: "chatcmpl_test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const res = await handleChatCompletions(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "opencode-zen/big-pickle",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(seen?.get("user-agent")).toBe(OPENCODE_ZEN_USER_AGENT);
    expect(seen?.get("x-opencode-client")).toBe("cli");
    expect(isOpenCodeZenIdentifier(seen?.get("x-opencode-session") ?? "", "ses")).toBe(true);
    expect(isOpenCodeZenIdentifier(seen?.get("x-opencode-request") ?? "", "msg")).toBe(true);
    expect(seen?.get("x-opencode-project")).toBe("global");
    const upstream = JSON.parse(seenBody) as {
      stream?: boolean;
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(upstream.stream).toBe(true);
    expect(upstream.tools?.[0]?.function?.name).toBe("bash");
    expect(upstream.tools?.some(tool => tool.function?.name === "grep")).toBe(true);
  });

  test("paid Zen models do not inherit the free-tier tool catalog", () => {
    const shaped = applyOpenCodeZenFreeTierBody(
      { model: "gpt-5.4", messages: [], stream: false },
      "chat",
      "gpt-5.4",
    );
    expect(shaped.stream).toBe(false);
    expect(shaped.tools).toBeUndefined();
  });

  test("non-zen providers are untouched by zen transport", () => {
    const before: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    };
    expect(resolveOpenCodeZenTransport(before)).toEqual(before);
  });
});
