# wp10 — Lane F: the five issues an earlier pass called environment-blocked

This lane exists because the wp6 writeup said triage candidates "remained outside this
campaign when they could not be triggered and observed in the available environment." That
sentence was not proven. Nobody had read the code and shown the defects were unreachable —
they had only failed to run them. Five issues were re-investigated from source, and **all
five were real defects**. The earlier verdict was wrong on every one.

The lesson is narrow and worth keeping: "I could not reproduce it here" and "it is not a
bug" are different claims, and only the first one was ever supported. A Windows defect is
still provable on macOS if you assert the contract rather than the outcome — mock the spawn
and check the options, instead of launching a tray and watching it die.

## What each one turned out to be

**#2804, tray exits after 3 seconds.** The detached fallback launched through
`UseShellExecute = true`, which drops the environment. `OCX_TRAY_ENTRY_B64` went with it,
so the host started, found no entry, threw `Missing tray host entry`, and died. Fixed in
`src/tray/windows.ts` along with the stale-stop-state reset ordering in the PowerShell
side, which only resets after it holds singleton ownership. Landed as #2856 (42b88dc93).

**#2800, a second home can never pass admitCodexWrite.** The probe treated a Task Scheduler
registration as machine-global: once `opencodex-proxy` was registered anywhere, a second
`OPENCODEX_HOME` with no task XML of its own got `unknown`, and `admitCodexWrite` must
refuse an unknown verdict. Ownership is now decided per home — a launcher registered outside
the effective home is another home's claim, not an unresolvable state. Missing or malformed
evidence for the current home still fails closed. Landed as #2857 (878d986e0).

**#2792, ERR_CONTENT_LENGTH_MISMATCH.** A `Bun.file` race: the declared `Content-Length`
could outlive the backing file, so the body written was shorter than the length promised.
Static assets are snapshotted before the response is framed. Verified on a live isolated
proxy — declared and received both 2,482,833 bytes, with and without gzip. Landed as #2859
(e546c160b).

**#2791, /api/log timeout loop.** The server was never the problem: it returns 2,000 entries
in about 2 ms. The client retried failed requests on the next tick with no backoff, so one
failure became a stream. Network attempts now back off 4/8/16/32 seconds while manual retry
stays immediate. That also explains the desktop-versus-mobile asymmetry the reporter saw —
the loop needed a first failure to start, so it was not mobile-specific at all. Landed as
#2859 (e546c160b).

**#2723, quota-blocked compact blocks the handoff.** Compact routed the client-supplied
previous model directly, and upstream Codex's current-model fallback is not reachable through
the custom-provider path, so an exhausted Sol kept being the compaction target. Worth
recording because it is easy to get wrong: `a52d00a6e` from earlier in this campaign does
**not** cover this. That commit fixes quota-based account candidate selection; compact model
and provider routing is a different path. The fix remembers the last successful compact model
per session lane and retries that same-thread handoff target on a body-confirmed quota
failure, preserving explicit 402/429 attribution. Landed as #2858 (676a3c03a).

## Verification boundary

The two Windows fixes are verified by fixture and spawn-contract assertion, not by an
end-to-end run on Windows 11, because no Windows machine was available. Both issue comments
say so plainly and ask the reporter to confirm from a `dev` build. The three non-Windows
fixes were exercised against a live proxy in an isolated home.

