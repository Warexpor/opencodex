# Claude instructions cache stabilize (OCXFIX)

Product-shaped OpenCodex inbound fix: strip growing `<total_tokens>` / TaskCreate
footers from Responses `instructions`, reattach latest as trailing `input`, so
Muse/Go prompt-cache prefixes stay stable for Claude Code.

## Paper

See [PAPER_OCXFIX.pdf](./PAPER_OCXFIX.pdf) (Warexpor).

Headline measured results (Muse Spark 1.3 contributor via OpenCode Go / OpenCodex):

| Slice | Baseline mean | OCXFIX mean |
| --- | ---: | ---: |
| Claude Code (n=75) | 0.168384 | 0.864374 |
| Claude S/T4 (n=5) | 0.134922 | 0.982700 |
| Grok Build (n=75) | 0.966526 | 0.941345 |

Cause: Anthropic→Responses conversion puts Claude system text in `instructions`;
Claude Code appends growing `<total_tokens>` (and rare TaskCreate nudges) →
`instructions_sha` churns every turn. Grok has no `instructions` field.

Code: `src/claude/inbound-cache-stabilize.ts` (wired from `inbound.ts`).