# ACCEPTANCE — Proposal Composer browser evidence (bounded review)

Reviewer: deepseek-flash (native image input). Read-only session: no source edit, no rerun, no browser/server launch, no installs/tests/builds/probes. Only file written: this one.

## Conclusion

**ACCEPT (MVP), with two recorded caveats.** All six intended behaviors are evidenced in raw captured payloads (decoded independently from `transcript.jsonl`), not merely by green receipt labels. No product-behavior failure found. One proof-implementation defect (the capture's own cleanup never closed its browser session) and one evidence-discrimination caveat (query A auto-select) are recorded below; the session-close criterion rests on the primary's independent post-run check, not on this capture.

## Ref and hash checks (all recomputed by this review)

- Worktree HEAD `12609d2488f281e625a314fa46c62b6bf202f478` = assigned base; branch `codex/plan-m-proposal-composer-a97d40fc55e`; only untracked `.cleanup-evidence/` and `proposal-router/` (no capture commits).
- Artifact sha256 exactly match the receipt table: `transcript.jsonl` `fee54d05…`, `snapshot-initial.json` `6686f332…`, `snapshot-query-b.json` `7b33512f…`, `screenshot-normal.png` `aa1e951d…`, `screenshot-copy-failed.png` `83ccf15a…`, `agent-browser.config.json` `ca3d163b…`. `receipt.json` itself (no self-hash) = `e2c87c1f…`.
- Captured source: `proposal-router/main.js` `838fd235…`, `router.js` `472c1508…`, `index.html` `b2ecd075…`, `styles.css` `c2b3fbdf…`, `repositories.json` `b2ea3a49…`; driver `proposal-browser-proof.ts` `ef59613e…`.
- Given capture ref `d13d5385…/5b2040c8-e3e7-45a0-92ca-d80b3f44972d` (exit 0, 2470 ms) is **not present on disk**. The on-disk receipt is worker `040-proposal-browser-proof`, outcome `passed`, `durationMs` 2322, `errors: []`, and it cites the earlier unit proof `…/2e9852da-b456-46b9-8415-d609b3e8b7e6` (matches the stated unit proof). I verified these artifacts by their own hashes; I cannot tie the `5b2040c8` UUID/duration to them from readable evidence. All 31 recorded commands have `code: 0`, `timedOut: false`; no driver-level exit code is captured.

## Six intended cases

| Case | Verdict | Raw evidence |
| --- | --- | --- |
| 1. Real local page | PASS | `open http://127.0.0.1:8138/proposal-router/` (title "Ubiquity Proposal Router"); snapshot tree has Proposal textbox, Target repository combobox, Open GitHub Issue link, Copy Link button; every state payload keeps the local origin. |
| 2. queryA pay ranking / auto-select | PASS, **caveat** | seq 9: `pay.ubq.fi` "Keyword match score: 100", ranked 1st of 5, selected, href to pay.ubq.fi. But seq 6 shows the catalog default was already `pay.ubq.fi`, so query A alone cannot discriminate ranking-driven auto-select from an unchanged default. Ranking-driven selection is independently evidenced by case 5 (kernel). |
| 3. Manual dollar kept under queryB, outside top 5 | PASS | seq 10 select `ubiquity/ubiquity-dollar`; seq 11 href retargets to dollar; seq 14 top 5 = kernel, plugin-installer, ubq.fi-router, .github, pay.ubq.fi (dollar absent), `selectOptions` = those 5 + dollar appended 6th, `selectValue` = dollar, href stays dollar. `snapshot-query-b.json` DOM confirms combobox value dollar and option e20. |
| 4. Encoded correct issue href | PASS | All four non-`#` hrefs equal the exactly form-urlencoded (`quote_plus`) title/body and decode back to the same text; initial href `#` with `aria-disabled=true`, enabled after fill; location never changes. |
| 5. Reload restores automatic selection | PASS | seq 17 reload; seq 19 proposal cleared, selection back to catalog default `pay.ubq.fi`, issue link disabled `#`; seq 20–22 re-fill query B → kernel auto-selected with 5 options (no stale pinned dollar). |
| 6. Clipboard resolve / reject feedback | PASS (stubbed clipboard) | Resolve: label `Copied`, exactly 1 write equal to the exact kernel href, href unchanged, page local. Reject: label `Copy failed`, hint "Clipboard blocked. Copy the address from the Open GitHub Issue link instead.", 2 writes, href unchanged. The real `#copy-link` handler ran, but `navigator.clipboard` was a controlled in-page stub and the 1400 ms label reset was suppressed — so neither the OS clipboard nor the transient reset is evidenced. |

Constraint checks: no issue navigation/submission — the only `github.com` strings in argv are three `wait --fn` href predicates; no `open`/`navigate` beyond the local page; `--allowed-domains 127.0.0.1,localhost`; empty `agent-browser.config.json`; child env only HOME/PATH/TMPDIR; proposal text synthetic; "Open GitHub Issue" never clicked.

## Material missing / failed item (proof, not product)

- **`99-cleanup` passed vacuously.** It holds zero assertions (receipt), and the close/verify branch never ran: `sessionTouched` is declared (driver line 191) and read (line 1265) but never assigned true, although the driver opened a session (seq 3) and used it for 28 subsequent recorded commands. Consequently the transcript ends at `copy-failure-screenshot` (31 entries; no `cleanup-close`, no `cleanup-session-after-close`), `sessionsAfterClose` is `null`, and the receipt note "no browser session was opened" is inaccurate. **This capture does not prove "own session absent after close"**; that criterion rests on the primary's independent post-run namespace session-list check (empty). Server stop is recorded (`staticServer.stopped: true`, stop routine ran) and corroborated by the primary's port-8138 check; no post-stop HTTP probe exists in the capture.

## Screenshot observations (native deepseek-flash vision)

Both PNGs are 1280×633 viewport crops, not full-page: the bottom of the composer is cut and the clipboard hint line is below the crop.

- `screenshot-normal.png`: two-column layout. Left card: "UBIQUITY" eyebrow, "Proposal Router" h1, boxed "Issue #123" link, Proposal textarea filled with the kernel proposal (caret at end), Issue title mirroring the text (truncated in field), Target repository combobox showing `ubiquity/ubiquity-doll…` (manual dollar selection retained), blue "Open GitHub Issue" button and "Copy Link". Right card: "Suggested Repositories" with kernel first ("Keyword match score: 100", "Matched: route, webhook, command, plugin, kernel"), then plugin-installer (50), then ubq.fi-router (50) partly visible.
- `screenshot-copy-failed.png`: same composition after reload + query B; Target repository now `ubiquity-os/ubiquity-o…` (kernel auto-selected) and the button reads "Copy failed". The clipboard-unavailable hint is not visible in the crop, so it is DOM-asserted only, not visually confirmed.

## UI findings (visible-region only, non-blocking)

| Before | After | Why |
| --- | --- | --- |
| Keyword score wraps into a narrow right column and collides visually with long repo slugs (kernel, plugin-installer) | Single-line score under the slug, or a compact chip in the card footer | The score is secondary metadata; a two-line "Keyword match score: 100" competes with the primary label and makes card headers ragged. |
| Selected Target repository value truncates (`ubiquity/ubiquity-doll…`, `ubiquity-os/ubiquity-o…`) | Show the full selection, or expose the full slug on focus/title | The chosen target is the key decision; users should not have to infer the repo from a clipped slug. |

## Honest MVP / hosting limits

- Local-only static demo (`deno @std/http` file-server on 127.0.0.1:8138); no HTTPS, hosting/CDN, or CI proof; no repository metadata fetched.
- Ranking is keyword scoring over the bundled `repositories.json`, capped at 5; not semantic.
- Issue creation is a prefilled `github.com` URL only: no GitHub API, no auth/credentials, nothing submitted.
- Clipboard is stubbed; real permission prompts, non-secure-origin behavior, and browsers other than Chromium are untested; the failure path is a text hint only.
- One 2322 ms single-engine, single-viewport capture (1280×633); no mobile, dark-mode, contrast, or accessibility audit; screenshots are crops.
- Unit proof `…/2e9852da-b456-46b9-8415-d609b3e8b7e6` was executed earlier by the primary and intentionally not rerun here.
