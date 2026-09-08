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

  test("three total_tokens footers keep only the latest in the notice", () => {
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

  test("instructions contain zero total_tokens after stripping", () => {
    const result = stabilizeClaudeInstructionsForPromptCache(
      `System.\n${footer(1)}\nMore system.\n${footer(3)}`,
    );
    expect(result.instructions).not.toMatch(/<total_tokens>/);
    expect(result.instructions).toContain("System.");
    expect(result.instructions).toContain("More system.");
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
});

describe("anthropicToResponsesTranslation cache-stabilize wire-in", () => {
  test("moves the latest total_tokens footer onto a trailing input user message", () => {
    const first = footer(1000);
    const latest = footer(8000);
    const { body } = anthropicToResponsesTranslation({
      model: "m",
      max_tokens: 1,
      system: ["You are Claude Code.", first, latest].join("\n\n"),
      messages: [{ role: "user", content: "hi" }],
    });
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
});
