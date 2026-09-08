/**
 * Claude Code appends growing `<total_tokens>…</total_tokens>` footers (and
 * occasional TaskCreate nudges) into system text that becomes Responses
 * `instructions`. That churn breaks Muse/Go prefix cache on the instructions
 * prefix even when tools stay stable. Strip dynamics from instructions;
 * surface the latest notice on `input` instead.
 *
 * Only canonical harness notices are stripped: a standalone integer
 * `<total_tokens>` line, and the exact TaskCreate reminder paragraph.
 * Inline documentation of those tags/tools is left in `instructions`.
 */

/** Standalone harness footer: own line, integer payload, not mid-sentence docs. */
const TOTAL_TOKENS_RE =
  /(?:^|\r?\n)[ \t]*(<total_tokens>\d+<\/total_tokens>)[ \t]*(?=\r?\n|$)/g;

/** Canonical Claude Code reminder: distinctive opening sentence through closing reminder. */
const TASKCREATE_NUDGE_RE =
  /(?:^|\r?\n)[ \t]*(The task tools haven't been used recently\.\s+If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them\.\s+Only use these if relevant to the current work\.\s+This is just a gentle reminder - ignore if not applicable\.)[ \t]*(?=\r?\n|$)/g;

export function stabilizeClaudeInstructionsForPromptCache(
  instructions: string,
): { instructions: string; dynamicNotice: string | null } {
  if (!instructions) {
    return { instructions: "", dynamicNotice: null };
  }

  let latestTotal: string | null = null;
  for (const m of instructions.matchAll(TOTAL_TOKENS_RE)) {
    latestTotal = m[1] ?? m[0];
  }

  let latestNudge: string | null = null;
  for (const m of instructions.matchAll(TASKCREATE_NUDGE_RE)) {
    latestNudge = (m[1] ?? m[0]).trim();
  }

  let cleaned = instructions.replace(TOTAL_TOKENS_RE, "");
  cleaned = cleaned.replace(TASKCREATE_NUDGE_RE, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  const noticeParts: string[] = [];
  if (latestTotal) noticeParts.push(latestTotal);
  if (latestNudge) noticeParts.push(latestNudge);
  const dynamicNotice = noticeParts.length > 0 ? noticeParts.join("\n\n") : null;

  return { instructions: cleaned, dynamicNotice };
}
