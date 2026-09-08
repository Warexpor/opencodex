/**
 * Claude Code appends growing `<total_tokens>…</total_tokens>` footers (and
 * occasional TaskCreate nudges) into system text that becomes Responses
 * `instructions`. That churn breaks Muse/Go prefix cache on the instructions
 * prefix even when tools stay stable. Strip dynamics from instructions;
 * surface the latest notice on `input` instead.
 */

const TOTAL_TOKENS_RE = /<total_tokens>[\s\S]*?<\/total_tokens>/g;

/** Matches TaskCreate nudge paragraphs appended mid-session. */
const TASKCREATE_NUDGE_RE =
  /The task tools haven't been used recently[\s\S]*?TaskCreate[\s\S]*?(?:Only use these if relevant to the current work\.\s*This is just a gentle reminder - ignore if not applicable\.|[^\n]*)/g;

export function stabilizeClaudeInstructionsForPromptCache(
  instructions: string,
): { instructions: string; dynamicNotice: string | null } {
  if (!instructions) {
    return { instructions: "", dynamicNotice: null };
  }

  let latestTotal: string | null = null;
  for (const m of instructions.matchAll(TOTAL_TOKENS_RE)) {
    latestTotal = m[0];
  }

  let latestNudge: string | null = null;
  for (const m of instructions.matchAll(TASKCREATE_NUDGE_RE)) {
    latestNudge = m[0].trim();
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
