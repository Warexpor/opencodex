# 013 — Final: what shipped and what the measurement taught

Supersedes the mechanism proposed in `010`/`011`/`012`. Those documents are kept
because the failed attempts are why the shipped fix is one declaration.

## Shipped

```css
.dash-sidecar-row-card .dash-sidecar-copy .setting-hint { min-height: 3lh; }
```

replacing `min-height: 3.9375rem` on the copy block.

## The defect, stated exactly

The pair's control rows sat **19.5px** apart — one line box — at every two-up width
from 1600 down to 740, in **ru** and **fr** only. Six other locales measured 0px.

The old band was 63px, documented as "21px title + 3px hint margin + two 19.5px
hint lines". It encodes a two-line assumption. The ru/fr vision hint wraps to
**three** lines at a two-up card (82.5px of copy against 63px), so the band stopped
describing the taller card and each card's control line followed its own copy.

`3lh` states the real constraint — reserve three line boxes of the hint's own
line-height — so the shorter hint reserves the same three lines, and a font or
line-height change cannot invalidate the number.

| locale | hint lines (web search / vision) | before | after |
|--------|----------------------------------|--------|-------|
| en | 2 / 2 | 0px | 0px |
| ko | 1 / 2 | 0px | 0px |
| ja | 2 / 2 | 0px | 0px |
| zh | 1 / 1 | 0px | 0px |
| de | 2 / 2 | 0px | 0px |
| tr | 2 / 2 | 0px | 0px |
| **ru** | **2 / 3** | **19.5px** | **0px** |
| **fr** | **2 / 3** | **19.5px** | **0px** |

## Why not subgrid

Shared row tracks are the textbook fix and the independent auditor recommended
them. They are unavailable here, and the evidence is unambiguous:

| attempt | measured result |
|---------|-----------------|
| card as subgrid, `container-type` on the card | never applied; computed `display` stayed `flex` |
| `container-type` moved to `.dash-sidecar-grid` | card's computed `grid-template-rows` = `none`; tracks 19px; cards 54px tall; controls overflowing 43-80px |
| `container-type` on `.dash-overview-stack` | same collapse |
| `auto` / `min-content` / `max-content` rows | no effect — the rejection is of `subgrid`, not the sizing |
| isolated clone, no container ancestor | worked, delta 0 — which is what identified containment as the cause |

Chrome rejects a child's `grid-template-rows: subgrid` when an ancestor
establishes layout containment via `container-type`. This surface has two such
containers (`.dash-sidecar-grid` and the per-card `sidecar-card` that the existing
narrow-card queries depend on), so there is no placement that does not block it.

## Two measurement failures worth keeping

Both produced confident, wrong "all clear" results. The harness now defends
against each.

**1. A symmetric break passes a relative gate.** The subgrid collapse reported
`ctrlYDelta = 0.0px` while cards rendered 54px instead of 215px, because both
cards were broken identically. Alignment deltas cannot see that. The gate now also
asserts absolute card height, child-vs-panel overflow, and hint truncation.

**2. A leftover probe stylesheet fakes a pass.** An earlier round reported "ALL
OK" for `align-content: start` across 30 cells. The number was real; the page was
not the shipped page — an injected experiment sheet from a previous probe was still
attached. The harness now strips every probe sheet before measuring, counts what
remains, and **fails** if the count is not what the run expects.

The second one is why `align-content: start` was briefly committed as the fix. It
is not in the shipped diff: re-measured on a clean page it leaves the full 19.5px,
because packing lines from the top does nothing when the copy rows themselves are
unequal.

## Deferred, per the audit

- `020` **withdrawn.** The `0px` third track is normal `auto-fit` behaviour for a
  collapsed empty track, not a defect. Replacing `auto-fit` with a fixed two-up
  would change future three-card behaviour for no present gain.
- `030` **reduced.** `dvw` does not subtract a classic scrollbar, so the toast fix
  must use containing-block insets / `max-inline-size`, not a unit swap. Only
  `.logs-table-wrap`'s `vh` → `dvh` survives.

## Evidence

- Harness: `.tmp/uiux/measure.ts` (scratch, not committed)
- Screenshots with control-row guides: before `-19.5px` / after `0px` at ru and fr, 1024
- Regression: `gui/tests/sidecar-layout.test.ts`, red on the previous CSS (2 fail), green on this one (8 pass)

