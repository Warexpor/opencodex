# Claude instructions cache stabilize (OCXFIX)

OpenCodex inbound conversion puts Claude Code system text into OpenAI Responses
`instructions`. Claude Code then appends a growing `<total_tokens>…</total_tokens>`
footer (and occasional TaskCreate nudges) on every turn. That prefix churn
causes prompt-cache misses on Muse/Go.

This change strips those dynamic footers from `instructions` and reattaches the
latest notice as a trailing `input` message so the cacheable prefix stays stable.

Relocation is opt-in: `translateAnthropicRequest` / `anthropicToResponsesTranslation`
take `stabilizePromptCache?: boolean` (default **false**). Ordinary Anthropic
callers keep a matching suffix in `instructions`. The Claude Code `/v1/messages`
inbound path passes `true`. The matcher is `<total_tokens>N tokens left</total_tokens>`
plus the exact TaskCreate paragraph; it is not gated on `metadata.user_id`.
Outside opt-in, the Desktop `prompt_cache_key` fallback hashes raw `systemParts`.
When opted in, that fallback hashes the same string as `body.instructions`.

## Paper

See [PAPER_OCXFIX.pdf](./PAPER_OCXFIX.pdf) (Warexpor).

Measured cache-hit rates on Muse Spark 1.3 via OpenCode Go / OpenCodex:

| Slice | Baseline mean | OCXFIX mean |
| --- | ---: | ---: |
| Claude Code (n=75) | 0.168384 | 0.864374 |
| Claude S/T4 (n=5) | 0.134922 | 0.982700 |
| Grok Build (n=75) | 0.966526 | 0.941345 |

Cause: Anthropic→Responses conversion stores Claude system text in `instructions`;
Claude Code appends growing `<total_tokens>` (and rare TaskCreate nudges), so
`instructions_sha` changes every turn. Grok traffic has no `instructions` field
and is the control.

Code: `src/claude/inbound-cache-stabilize.ts`, wired from `src/claude/inbound.ts`.
