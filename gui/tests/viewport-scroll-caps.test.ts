import { expect, test } from "bun:test";

/**
 * Viewport-dependent sizing contracts in the shared stylesheet.
 *
 * Source-text assertions, not rendered measurements: happy-dom performs no layout, so a
 * computed max-width here would prove nothing. Rendered proof was captured in a real
 * browser via CDP while fixing these two rules; this file's job is to stop the specific
 * shapes that caused the defects from coming back silently.
 */

const cssUrl = new URL("../src/styles.css", import.meta.url);

/** Strip comments so no assertion can pass on prose that quotes an old value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** All bodies for a selector, which may be declared more than once. */
function allRuleBodies(css: string, selector: string): string {
  return ruleBodies(css, selector).join("\n");
}

/** Every body for a selector, in source order. */
function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp("(^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "g"))];
  if (matches.length === 0) throw new Error("rule not found: " + selector);
  return matches.map((m) => m[2]);
}

/**
 * The declaration that actually wins for a property: the LAST one across all bodies of
 * the selector.
 *
 * Concatenating bodies and taking the first match is what a reviewer correctly called a
 * false negative: a second rule for the same selector, added later with a wrong value,
 * wins the cascade while the first (correct) declaration still satisfies the assertion.
 * Reading the last occurrence is what makes these tests describe the rendered result.
 */
function effectiveDeclaration(css: string, selector: string, property: string): string {
  const pattern = new RegExp(property + "\\s*:\\s*([^;}]+)", "g");
  let winner: string | null = null;
  for (const body of ruleBodies(css, selector)) {
    for (const m of body.matchAll(pattern)) winner = m[1].trim();
  }
  if (winner === null) throw new Error("property not found: " + selector + " { " + property + " }");
  return winner;
}

test("the log table caps its scroll height against the dynamic viewport", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const wrap = allRuleBodies(css, ".logs-table-wrap");

  // Static `vh` resolves against the LARGE viewport, which ignores mobile browser chrome:
  // the cap is then computed for a viewport taller than the one the user can see and the
  // last rows sit underneath the address bar. The rest of the shell (.app, .sidebar,
  // .main-inner--combos, the mobile drawer) already uses 100dvh, so this rule was the
  // outlier rather than the convention.
  // The subtrahend is locked, not just the unit: a `calc(100dvh - <anything>)` would
  // satisfy a unit-only assertion while silently resizing the table. Read from the
  // EFFECTIVE declaration so a later duplicate rule cannot hide behind this one.
  const effective = effectiveDeclaration(css, ".logs-table-wrap", "max-height");
  const cap = effective.match(/^calc\(\s*100dvh\s*-\s*([\d.]+)px\s*\)$/);
  expect(cap).not.toBeNull();
  expect(Number(cap![1])).toBe(260);
  expect(wrap).not.toMatch(/max-height:\s*calc\(\s*100vh\s*-/);
});

test("the toast width cap outranks the later .notice rule", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());

  // Every toast carries BOTH classes, and `.notice { max-width: var(--prose-measure) }`
  // (70ch = 542px) is declared later in this same file at equal specificity 0,1,0. Source
  // order therefore won and a single-class `.action-toast` cap never applied - the toast
  // rendered 542px instead of its design width. Two classes is what wins the cascade, so
  // the cap must stay on the compound selector.
  // Again the EFFECTIVE declaration, for the same reason: a second `.action-toast.notice`
  // rule added later with a wrong width would win the cascade while the first one still
  // matched a first-occurrence assertion.
  const effective = effectiveDeclaration(css, ".action-toast.notice", "max-width");
  const cap = effective.match(/^min\(\s*([\d.]+)px\s*,\s*calc\(\s*100vw\s*-\s*([\d.]+)px\s*\)\s*\)$/);

  // Both halves are asserted on purpose. An earlier revision kept only the design width,
  // which dropped the viewport term and let the toast reach the screen edge at narrow
  // widths (measured left = 0 at 430px, losing the 24px inset the right side keeps).
  // Exact values, not merely positive ones: a 1px design width or a 1px inset would pass
  // a `> 0` check while destroying the layout. 480px is the design width and 48px is the
  // 24px inset doubled, both measured on the rendered toast.
  expect(cap).not.toBeNull();
  expect(Number(cap![1])).toBe(480);
  expect(Number(cap![2])).toBe(48);

  // Guard the ordering premise itself: if `.notice` ever moved ABOVE this rule, a
  // single-class cap would start working and someone could "simplify" the compound
  // selector away. The assertion is only meaningful while `.notice` still comes later.
  const noticeIndex = css.search(/(^|\n)\s*\.notice\s*\{/);
  const compoundIndex = css.search(/(^|\n)\s*\.action-toast\.notice\s*\{/);
  expect(compoundIndex).toBeGreaterThanOrEqual(0);
  expect(noticeIndex).toBeGreaterThan(compoundIndex);
});
