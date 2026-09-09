import { describe, expect, test } from "bun:test";
import { stabilizeClaudeInstructionsForPromptCache } from "../../src/claude/inbound-cache-stabilize";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";

const TASKCREATE_NUDGE = [
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them.",
  "Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
].join(" ");

function footer(used: number): string {
  return `<total_tokens>${used}</total_tokens>`;
}

function translate(system: string) {
  return anthropicToResponsesTranslation({
    model: "m",
    max_tokens: 1,
    system,
    messages: [{ role: "user", content: "hi" }],
  });
}

describe("stabilizeClaudeInstructionsForPromptCache", () => {
  test("empty input is a no-op", () => {
    expect(stabilizeClaudeInstructionsForPromptCache("")).toEqual({
      instructions: "",
      dynamicNotice: null,
    });
  });

  test("stable instructions without dynamics pass through", () => {
    const instructions = "You are Claude Code.\n\nPrefer terse answers.";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("no-match whitespace is returned byte-for-byte", () => {
    const instructions = "You are Claude Code.\n\n\nPrefer terse answers.\n";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("whitespace-only system without a footer is unchanged", () => {
    const instructions = "  \n\n  ";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("three trailing total_tokens footers keep only the latest in the notice", () => {
    const stable = "You are Claude Code.";
    const first = footer(1000);
    const second = footer(4000);
    const third = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [stable, first, second, third].join("\n\n"),
    );
    expect(result.instructions).toBe(stable);
    expect(result.instructions).not.toContain("<total_tokens>");
    expect(result.dynamicNotice).toBe(third);
  });

  test("mid-document total_tokens stays; only the trailing harness footer relocates", () => {
    const result = stabilizeClaudeInstructionsForPromptCache(
      `System.\n${footer(1)}\nMore system.\n${footer(3)}`,
    );
    expect(result.instructions).toBe(`System.\n${footer(1)}\nMore system.`);
    expect(result.dynamicNotice).toBe(footer(3));
  });

  test("TaskCreate nudge is stripped from instructions and kept in the notice", () => {
    const stable = "You are Claude Code.";
    const result = stabilizeClaudeInstructionsForPromptCache(
      `${stable}\n\n${TASKCREATE_NUDGE}`,
    );
    expect(result.instructions).toBe(stable);
    expect(result.instructions).not.toContain("TaskCreate");
    expect(result.dynamicNotice).toBe(TASKCREATE_NUDGE);
  });

  test("latest footer and latest nudge both surface in the notice", () => {
    const stable = "Stay stable.";
    const older = footer(10);
    const latest = footer(50);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [stable, older, TASKCREATE_NUDGE, latest].join("\n\n"),
    );
    expect(result.instructions).toBe(stable);
    expect(result.dynamicNotice).toBe(`${latest}\n\n${TASKCREATE_NUDGE}`);
  });

  test("inline documentation of total_tokens tags stays in instructions", () => {
    const docs = "The harness may emit a <total_tokens>123</total_tokens> footer; do not invent one.";
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("TaskCreate mentioned in docs is not treated as the harness nudge", () => {
    const docs = "The task tools haven't been used recently. You may mention TaskCreate in docs without the reminder.";
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("fenced standalone total_tokens example stays byte-for-byte", () => {
    const docs = ["You are a docs bot.", "```", footer(123), "```", ""].join("\n");
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("docs plus a real trailing footer keep the docs and move only the latest footer", () => {
    const docs = "Describe <total_tokens>0</total_tokens> in the protocol guide.";
    const latest = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [docs, footer(1), latest].join("\n\n"),
    );
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBe(latest);
  });

  test("fenced example plus a trailing harness footer moves only the footer", () => {
    const docs = ["Docs:", "```", footer(123), "```"].join("\n");
    const latest = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(`${docs}\n\n${latest}`);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBe(latest);
  });
});

describe("anthropicToResponsesTranslation cache-stabilize wire-in", () => {
  test("moves the latest total_tokens footer onto a trailing input user message", () => {
    const first = footer(1000);
    const latest = footer(8000);
    const { body } = translate(["You are Claude Code.", first, latest].join("\n\n"));
    expect(body.instructions).toBe("You are Claude Code.");
    expect(String(body.instructions)).not.toContain("<total_tokens>");
    const input = body.input as Array<Record<string, unknown>>;
    const last = input[input.length - 1]!;
    expect(last).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: latest }],
    });
    expect(input.some(item => item.role === "user" && item !== last)).toBe(true);
  });

  test("fenced standalone total_tokens example is a translator no-op", () => {
    const system = ["You are a docs bot.", "```", footer(123), "```", ""].join("\n");
    const { body } = translate(system);
    expect(body.instructions).toBe(system);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("whitespace-only system without a footer is preserved byte-for-byte", () => {
    const system = "  \n\n  ";
    const { body } = translate(system);
    expect(body.instructions).toBe(system);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("Desktop prompt_cache_key fallback hashes stabilized instructions, not total_tokens footers", () => {
    const stable = "You are Claude Code.";
    const keyOf = (system: string) => translate(system).body.prompt_cache_key as string;
    const stableKey = keyOf(stable);
    expect(stableKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf([stable, footer(1000), footer(8000)].join("\n\n"))).toBe(stableKey);
    expect(keyOf([stable, footer(99999)].join("\n\n"))).toBe(stableKey);
  });
});
