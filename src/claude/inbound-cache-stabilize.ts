/**
 * Claude Code appends growing `<total_tokens>…</total_tokens>` footers (and
 * occasional TaskCreate nudges) into system text that becomes Responses
 * `instructions`. That churn breaks Muse/Go prefix cache on the instructions
 * prefix even when tools stay stable. Strip dynamics from instructions;
 * surface the latest notice on `input` instead.
 *
 * Relocation is identified by harness shape: only a trailing, unfenced,
 * canonical notice at the end of instructions is moved. An unmatched fence
 * opener covers through EOF. No match → the original string is returned
 * byte-for-byte. The matcher is content identity only; `translateAnthropicRequest`
 * must pass `stabilizePromptCache: true` before this helper runs. Claude Code
 * writes `<total_tokens>N tokens left</total_tokens>`.
 *
 * TaskCreate nudge text has drifted across Claude Code builds; match the
 * known exact paragraphs (legacy + 2.1.263 "tracking progress" form) as
 * trailing alternatives so a mid-session nudge cannot pin older footers
 * above it and flip `instructions` after a previously stable peel.
 */

const TRAILING_TOTAL_RE =
  /(?:^|(?:\r?\n)+)[ \t]*(<total_tokens>\d+\s+tokens left<\/total_tokens>)[ \t]*(?:\r?\n)*$/;

/** Legacy Claude Code TaskCreate reminder (pre-"tracking progress"). */
const TASKCREATE_NUDGE_LEGACY =
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

/**
 * Claude Code 2.1.263+ TaskCreate reminder observed on hitrate S/T4
 * (FREEZE-DIFF + tip0847 pilots). Mentions TaskUpdate and stale-list cleanup.
 */
const TASKCREATE_NUDGE_CC_2_1_263 =
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

const TRAILING_NUDGE_RE = new RegExp(
  `(?:^|(?:\\r?\\n)+)[ \\t]*(${escapeRegExp(TASKCREATE_NUDGE_LEGACY)}|${escapeRegExp(TASKCREATE_NUDGE_CC_2_1_263)})[ \\t]*(?:\\r?\\n)*$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface FenceRange {
  start: number;
  end: number;
}

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;

/**
 * Markdown fence ranges. An unmatched opener covers through EOF: unfinished
 * fenced examples are code content, not a harness suffix. A closer must be a
 * standalone fence line (no info string) of the same character and at least
 * the opener's length.
 */
function fencedRanges(source: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  let offset = 0;
  let openAt: number | null = null;
  let openFence = "";
  while (offset <= source.length) {
    const nl = source.indexOf("\n", offset);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(offset, lineEnd).replace(/\r$/, "");
    if (openAt === null) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        openAt = offset;
        openFence = open[2]!;
      }
    } else {
      const close = FENCE_CLOSE_RE.exec(line);
      if (
        close
        && close[2]![0] === openFence[0]
        && close[2]!.length >= openFence.length
      ) {
        ranges.push({ start: openAt, end: lineEnd });
        openAt = null;
        openFence = "";
      }
    }
    if (nl === -1) break;
    offset = nl + 1;
  }
  if (openAt !== null) ranges.push({ start: openAt, end: source.length });
  return ranges;
}

function isInsideFence(ranges: readonly FenceRange[], index: number): boolean {
  return ranges.some(range => index >= range.start && index < range.end);
}

function peelOne(
  rest: string,
  ranges: readonly FenceRange[],
): { rest: string; total?: string; nudge?: string } | null {
  const total = rest.match(TRAILING_TOTAL_RE);
  if (total?.[1]) {
    const matchStart = rest.length - total[0].length;
    const tagAt = matchStart + total[0].indexOf(total[1]);
    if (!isInsideFence(ranges, tagAt)) {
      return { rest: rest.slice(0, rest.length - total[0].length), total: total[1] };
    }
  }
  const nudge = rest.match(TRAILING_NUDGE_RE);
  if (nudge?.[1]) {
    const matchStart = rest.length - nudge[0].length;
    const tagAt = matchStart + nudge[0].indexOf(nudge[1]);
    if (!isInsideFence(ranges, tagAt)) {
      return { rest: rest.slice(0, rest.length - nudge[0].length), nudge: nudge[1] };
    }
  }
  return null;
}

export function stabilizeClaudeInstructionsForPromptCache(
  instructions: string,
): { instructions: string; dynamicNotice: string | null } {
  if (!instructions) {
    return { instructions: "", dynamicNotice: null };
  }

  const ranges = fencedRanges(instructions);
  let rest = instructions;
  let latestTotal: string | null = null;
  let latestNudge: string | null = null;
  let peeled = false;
  for (;;) {
    const next = peelOne(rest, ranges);
    if (!next) break;
    peeled = true;
    rest = next.rest;
    if (next.total && latestTotal === null) latestTotal = next.total;
    if (next.nudge && latestNudge === null) latestNudge = next.nudge;
  }

  if (!peeled) {
    return { instructions, dynamicNotice: null };
  }

  const noticeParts: string[] = [];
  if (latestTotal) noticeParts.push(latestTotal);
  if (latestNudge) noticeParts.push(latestNudge);
  const dynamicNotice = noticeParts.length > 0 ? noticeParts.join("\n\n") : null;

  return { instructions: rest, dynamicNotice };
}
