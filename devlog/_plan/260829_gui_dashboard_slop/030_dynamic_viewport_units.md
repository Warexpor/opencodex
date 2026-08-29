# 030 — Dynamic viewport units in scroll surfaces (wp3)

## Defect

`gui/src/styles.css:2003`:

```css
.logs-table-wrap { max-height: calc(100vh - 260px); }
```

`vh` is the *large* viewport: it ignores mobile browser chrome, so the log table
is capped for a viewport taller than the one the user can see, pushing the last
rows under the browser UI. The rest of the shell already moved to `100dvh`
(styles.css:244, 247, 411, 412, 2198), so this line is an outlier, not a
convention.

`styles.css:755` and `1222` cap toast width with `calc(100vw - Npx)`. `100vw`
excludes a classic scrollbar's width, so on a scrollbar-reserving platform the
toast can exceed the visible area.

## Change

- `.logs-table-wrap` → `max-height: calc(100dvh - 260px)`.
- Toast caps → `min(<width>, calc(100dvw - Npx))`, keeping each existing pixel
  inset.
- `styles.css:2003` is the only static `vh` in a scroll surface; the `12vh`
  padding on the toast wrapper is decorative offset, not a size cap, and stays.

## Verification

Behavioural, not textual: the probe compares each scroll container's computed
`max-height` against `visualViewport.height` and counts any cap that exceeds it
(`staticVh`). The gate fails on a non-zero count, so the assertion survives a
selector rename. Measured at a mobile profile where the visual viewport is
smaller than the large viewport.

## Acceptance

- `staticVh = 0` at every swept cell, including the 430-wide mobile profile.
- No `calc(100vh` remaining in a scroll-surface cap.

