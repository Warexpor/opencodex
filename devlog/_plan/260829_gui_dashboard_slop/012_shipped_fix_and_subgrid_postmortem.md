# 012 — What actually shipped, and why subgrid could not

`010` proposed subgrid; `011` corrected its premise but still recommended shared
row tracks. Both were wrong about the mechanism. This is the record of what the
experiments showed, kept because the failed attempts are the reason the shipped
fix is one line.

## The shipped fix

```css
.dash-sidecar-row-card { align-content: start; }
```

Measured: worst paired offset **0.0px** (was 27.8px) across `en/ko/ru/fr/ja/zh/de/tr`
at 1024 and 1100, plus the regime boundaries 1600/1440/1010/760/1000/992/430 on
the two longest-hint locales. Card heights and the one-column horizontal row are
unchanged.

## Why the copy band was never the cause

The band (`min-height: 3.9375rem`) looked like the culprit and the plan called for
deleting it. The decisive experiment says otherwise: with the band in place and
`align-content` still at its default, the two copy blocks measured **equal**
(63/63) while the control rows were still **27.4px apart**. Equal copy height is
therefore necessary but not sufficient — the mis-distributed thing is the wrapped
**lines**, not the copy.

So the band stays. It is load-bearing, just for a different reason than its
comment claimed: it equalises the copy row that `align-content: start` then packs
against. Deleting it would have re-broken the pair while the new rule kept
measuring 0.0px at the locales that happen to wrap identically.

## Why subgrid is unavailable here

Shared row tracks are the textbook fix, and the independent auditor recommended
them. They cannot work in this tree:

| attempt | result |
|---------|--------|
| card as subgrid, `container-type` on the card | never applied; computed `display` stayed `flex` |
| `container-type` moved to `.dash-sidecar-grid` | card's computed `grid-template-rows` = `none`; rows collapsed to 19px; cards 54px tall; controls overflowing 43-80px |
| `container-type` on `.dash-overview-stack` | same collapse |
| `min-content` / `max-content` / `auto` row sizing | no effect; the rejection is of `subgrid` itself, not the track sizing |
| isolated clone with no container ancestor | worked perfectly, delta 0 — which is what identified containment as the cause |

Chrome rejects a child's `grid-template-rows: subgrid` when an ancestor
establishes layout containment via `container-type: inline-size`. This surface has
two such containers (`.dash-sidecar-grid` and the per-card `sidecar-card` used by
the existing narrow-card queries), so there is no position for the container that
does not also block the subgrid. Removing the queries to make room would trade a
27px offset for the wrong-axis bug they were introduced to fix.

## The measurement lesson

The subgrid collapse **passed the alignment gate**: `ctrlYDelta` read 0.0px while
cards rendered 54px instead of 215px, because both cards were broken *identically*.
A relative metric cannot see a symmetric failure. The gate now also asserts
absolute card height and that no child overflows its panel, which is what caught
it.

## Deferred, per the audit

Auditor blockers 6 and 7 are accepted and remove work from `020`/`030` rather than
adding it:

- The `0px` third track is **normal** `auto-fit` behaviour for a collapsed empty
  track, not a defect. Replacing `auto-fit` with a fixed two-up would change
  future three-card behaviour for no present gain. `020` is withdrawn.
- `dvw` does not subtract a classic scrollbar, so the toast fix must use
  containing-block insets / `max-inline-size: 100%`, not a unit swap. Only the
  `.logs-table-wrap` `vh` → `dvh` change survives from `030`.

