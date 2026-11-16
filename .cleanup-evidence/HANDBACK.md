# HANDBACK — worker 038-proposal-composer (proposal-router extraction from PR #134)

- **Lane (cwd):** `/home/codex/repos/ubiquity/.github/.codex-worktrees/plan-m-proposal-composer-a97d40fc55e`
- **Branch / base:** `codex/plan-m-proposal-composer-a97d40fc55e` @ `12609d2488f281e625a314fa46c62b6bf202f478` (uncommitted owned edits only)
- **Git events:** none — no commits, pushes, branches, worktrees, PRs, comments, deployments, children or background jobs. `git status --short --branch` = `## codex/plan-m-proposal-composer-a97d40fc55e` + `?? proposal-router/`; canonical `.github` `main` still at `12609d2`.
- **Production claims:** none. No hosted service, no deployment, no issue created or submitted.

## Changed paths (all owned) + sha256

| Path | status | sha256 |
| --- | --- | --- |
| `proposal-router/router.js` | new (donor logic + 2 corrections/helpers) | `472c1508a5acbf86e5f62c7717da90936ce013dcc422161d812b771b9a11c1ae` |
| `proposal-router/repositories.json` | new, byte-identical to donor | `b2ea3a491e7df8c7e6d589df3e2111511fba4fe3f52378f1159431d1438155e1` |
| `proposal-router/router.test.mjs` | new (donor assertions preserved + regression assertions) | `42cc69488140e2615c45fcf2b016bbbd2eec5ca1d212d73525d0a028826e0ba9` |
| `proposal-router/index.html` | new, byte-identical to donor | `b2ecd075fdec031cf7dd582d7cdf69b7fbd19bcabbd0624f3f2fa859b7f62ac8` |
| `proposal-router/styles.css` | new, byte-identical to donor | `c2b3fbdfe5514e024b32e6479e3c0a71daa319cc0619d725a6f475ec4df01013` |
| `proposal-router/main.js` | new (donor DOM wiring + 3 corrections) | `838fd235d19646697bf41350fcadef5294e3788b2d810233907ba19619c67b4e` |
| `proposal-router/README.md` | new (honest scope/limitations + attribution) | `88699da7bb4e012fcc5dcd09a759ab3a66481c8a7df606ab2f1b5c2c249bd685` |

Not touched: every other product file, root config/workflows/template-sync rules, other repositories, central artifacts. Only `proposal-router/**` and this file were written.

## Donor attribution

- Source: `ubiquity/.github` PR #134 by **wognsdl2**, head `de3a5a618896d7354eea968c90c8de8ff5a6fdb3`, written for bounty issue #123.
- Contribution preserved: full tokenizer/stop-word set, `scoreRepository` scoring rules (name 4, haystack 2, phrase 5/3, clamped score), `rankRepositories`, `createIssueUrl` with `URLSearchParams`, `inferTitle` (90-char truncation), all seven files' structure, the catalog of eight verified repositories, and the donor markup/style.
- PR #132/#133 (command-execution/server-side design) contributed nothing and is rejected entirely; nothing from it is present.
- Attribution lives in `proposal-router/README.md` (public) and a header comment in `router.js`.

## Corrections applied (against the exact donor revision)

1. **Honest clipboard feedback** (`main.js`): the unguarded `await navigator.clipboard.writeText(...)` / unconditional `"Copied"` is now `try/catch` with a missing-API guard; success shows `Copied`, rejection or unavailable Clipboard API shows `Copy failed` (plus an explanatory `title` hint) and restores `Copy Link` after 1400 ms. The donor's 1400 ms reset is preserved.
2. **Explicit repository choice is never silently retargeted** (`main.js` + new pure `resolveRepositorySelection` in `router.js`): a user choice (select `change`, or clicking a suggestion card) sets `explicitSelectionKey`. Every re-rank re-selects that key and appends its option when it has dropped out of the top-5 suggestions; the option stays available and the issue link keeps pointing at the chosen repository. Without a manual choice, the top-ranked suggestion stays auto-selected as before.
3. **Catalog-validated selection and URL construction** (`router.js` + `main.js`): `selectedRepository()` is a catalog lookup that returns `null` when the value is absent (donor fell back to `repositories[0]`); the issue URL is only built for a catalog entry. `resolveRepositorySelection` rejects keys that are not in `repositories.json` and never renders them as options. `createIssueUrl` still builds the URL with `URLSearchParams` (unchanged).
4. **Keyword match score, not a probability**: the donor `confidence` field is renamed `matchScore` with an explicit comment that it is a relative keyword-overlap heuristic, and the UI renders `Keyword match score: <n>` instead of `<n>%`. The scoring math and ordering are unchanged. `README.md` repeats the qualification.
5. **No raw user text into HTML** (verified, not changed): every dynamic string goes through `textContent`; grep for `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` over `proposal-router/` returns nothing. The only proposal/title path into the DOM is `createIssueUrl` → `issueLink.href`.
6. **Honest README** documenting that this is the extracted keyword-based static MVP, not the issue's preferred issue/comment-database matching, embeddings, Telegram integration, time/price estimates, DevPool distribution, automatic posting, or a hosted production service; hosting remains unchosen; the "Open GitHub Issue" link only prepares a URL a human may later submit.

Two small additions beyond the four listed corrections, disclosed for the primary's judgment:

- `main.js` wraps the catalog `fetch` in `try/catch`: on failure the results list shows "Repository catalog unavailable. Serve this folder over HTTP and reload." and the select is disabled, instead of an unhandled top-level rejection leaving an inert page. No fake success state.
- `renderRepositoryOptions` only rebuilds the `<select>` children when the option list actually changed, so typing does not churn (or close) an open dropdown. No visual or behavior change otherwise.

Deliberately **not** done: no CSS or motion changes (the copy button label change is the only width change, and it is the last flex item, so nothing else shifts); no restyle pass; no dependencies; no root config; no test framework; no formatter.

## Interaction quality (Emil skill Before/After/Why)

| Before (donor) | After (extracted) | Why |
| --- | --- | --- |
| `confidence` shown as `42%` | `matchScore` shown as `Keyword match score: 42` | A heuristic over curated keywords must not read as a calibrated probability; ordering math is untouched. |
| Clipboard write unguarded, label always `Copied` | `try/catch` + API-presence guard; `Copied` or `Copy failed` + hint | Feedback must stay truthful when the browser denies or lacks the Clipboard API. |
| `<select>` rebuilt from the top-5 on each keystroke, value reset to rank 1 | Manual choice pinned by `change`/card click; re-selected and appended when it leaves the top-5 | A deliberate decision must never be silently retargeted by later typing. |
| Options rebuilt on every keystroke (`replaceChildren`) | Rebuild only when the key list changes | Avoids churning the control (and an open dropdown) while the user is typing. |
| `selectedRepository()` fell back to `repositories[0]` | Catalog-validated lookup, `null` when absent | A value that is not in the committed catalog can never become the issue target. |
| Fetch failure = unhandled rejection, inert page | Notice in the results list + disabled select | Honest failure state instead of a page that looks usable but does nothing. |

No animation/transition was added anywhere; keyboard behavior is the donor's native `<select>`/anchor/button behavior, and labels/focus styling are unchanged.

## Exact relay targets (primary-owned)

From the worktree root:

1. **Focused check (Node, donor command):** `node proposal-router/router.test.mjs` → expected stdout `proposal-router tests passed`, exit 0.
2. **Same script via Deno Node compatibility:** `deno run --allow-read proposal-router/router.test.mjs` → same output/exit.
3. **Static preview server (browser acceptance):** `deno run --allow-read --allow-net jsr:@std/http/file-server` from the worktree root, then `http://127.0.0.1:8000/proposal-router/`. The documented server command is new (the donor README used `python -m http.server`); it was not executed here.

`router.test.mjs` now runs 16 assertions: the donor's 4 (pay.ubq.fi on a payment proposal, kernel on a webhook/plugin proposal, `inferTitle`, exact `createIssueUrl` string), 2 on `matchScore` being an integer in 0-100, 2 round-tripping `&`/`#`/`?`/newline through the generated URL, and 8 on selection: manual choice outside the top suggestions is preserved and appended, a non-catalog key is never selected or offered, all offered keys exist in the catalog, and with no manual choice the top-ranked suggestion is selected. Deterministic premise for the regression case: on the kernel proposal only `ubiquity-os-kernel` (rate 0 + 4 name + phrases), `ubiquity-os-plugin-installer` and `ubq.fi-router` score above zero, so `pay.ubq.fi` (score 0) is outside the `limit: 2` suggestions.

## Browser acceptance flow (primary-owned; verified deterministically against the committed catalog)

Use two queries and never click `Open GitHub Issue` (read `#issue-link`'s `href` from the DOM only). No GitHub navigation and no submission.

1. **Load** `http://127.0.0.1:8000/proposal-router/`: 5 suggestion cards (catalog slice), `Target repository` = `ubiquity/pay.ubq.fi`, `Open GitHub Issue` disabled (`aria-disabled="true"`, `href="#"`), and the score label reads `Keyword match score: <n>` (no `%`).
2. **Query A** into `#proposal`: `Fix the cash out interface on pay.ubq.fi because the claim screen is not centered.`
   - First suggestion card = `ubiquity/pay.ubq.fi`; select = `ubiquity/pay.ubq.fi`; issue title auto-filled with the first line.
   - `#issue-link` href = `https://github.com/ubiquity/pay.ubq.fi/issues/new?title=Fix+the+cash+out+interface+on+pay.ubq.fi+because+the+claim+screen+is+not+centered.&body=Fix+the+cash+out+interface+on+pay.ubq.fi+because+the+claim+screen+is+not+centered.`
3. **Explicit choice:** pick `ubiquity/ubiquity-dollar` in `Target repository` (present in that select's options for query A). The href switches to the `ubiquity/ubiquity-dollar` issue URL.
4. **Query B** replaces the proposal text: `Route a new webhook command to the correct plugin in the kernel.`
   - Suggestion cards re-rank with `ubiquity-os/ubiquity-os-kernel` first.
   - **Regression check:** select still reads `ubiquity/ubiquity-dollar`; the option list has 6 entries with `ubiquity/ubiquity-dollar` last (appended after the 5 ranked options); `#issue-link` href = `https://github.com/ubiquity/ubiquity-dollar/issues/new?title=Route+a+new+webhook+command+to+the+correct+plugin+in+the+kernel.&body=Route+a+new+webhook+command+to+the+correct+plugin+in+the+kernel.` — **not** the kernel URL.
5. **Auto-selection control (fresh reload, no explicit choice):** paste Query B first → select auto = `ubiquity-os/ubiquity-os-kernel`, and further edits keep following the top-ranked suggestion.
6. **Clipboard success:** with the page focused and clipboard-write granted, click `Copy Link` → label `Copied`, and `navigator.clipboard.readText()` equals the current href; label returns to `Copy Link` after ~1.4 s.
7. **Clipboard failure:** deny clipboard-write for the context (e.g. Playwright `context.clearPermissions()`), or load the same page from an insecure (non-localhost) origin so `navigator.clipboard` is undefined → click `Copy Link` → label reads `Copy failed`, never `Copied`, and the href is unchanged. A stubbed `navigator.clipboard.writeText = () => Promise.reject(...)` may supplement the deterministic check but is weaker evidence than a real permission denial.

## Checks performed here (static review only — not acceptance evidence)

- Extracted the seven donor files from `reviews/.github/evidence/pr-134.diff` (head `de3a5a61`) and diffed them against the written files: `index.html`, `styles.css` and `repositories.json` are byte-identical; the `main.js`/`router.js`/`router.test.mjs` diffs contain only the corrections, helpers and assertions listed above.
- `grep -rn "innerHTML|outerHTML|insertAdjacentHTML|document.write" proposal-router/` → no matches.
- `git status --short --branch` → only `?? proposal-router/`; base HEAD `12609d2` matches the assignment.
- sha256 recorded above.
- **Not run here (per assignment):** `router.test.mjs`, any build, any install, any server, any browser. No test output was fabricated; no server was started; no GitHub URL was opened.

## Limitations / uncertainties

1. The focused test and browser acceptance are unverified in this worker; the primary relays them after settled handback under the shared heavy lock.
2. The documented `jsr:@std/http/file-server` preview command and the Deno Node-compat test command were not executed here. Only the Node command is donor-original.
3. Choosing the option that is already selected fires no `change` event in a `<select>`, so that no-op cannot be distinguished from "no manual choice"; a later edit may then follow the new top-ranked repository. Any actual value change, or a click on a suggestion card, sets the explicit choice. Flagging it as an edge case, not fixing it with speculative DOM events.
4. `resolveRepositorySelection` validates membership in `repositories.json`, not liveness of the GitHub repository. All eight catalog entries were verified to exist by the PR-cleanup review (2026-05-13 captures); no network check was made here.
5. The donor keyword heuristic over-matches short tokens (`route` matches `router`) and can score `ubq` inside `pay.ubq.fi`; both are preserved as donor behavior and are now labelled as a heuristic rather than a probability.
6. Hosting is still unchosen in issue #123 and no issue was created, transferred, or closed. Do not treat this handback as closing the bounty; the primary decides that separately.
