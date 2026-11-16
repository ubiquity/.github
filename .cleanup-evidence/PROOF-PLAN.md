# PROOF-PLAN — 040-proposal-browser-proof (proposal-router real-browser acceptance)

- **Worker:** 040-proposal-browser-proof
- **Lane (cwd):** `/home/codex/repos/ubiquity/.github/.codex-worktrees/plan-m-proposal-composer-a97d40fc55e`
- **Branch / base:** `codex/plan-m-proposal-composer-a97d40fc55e` @ `12609d2488f281e625a314fa46c62b6bf202f478`
- **Owned writes:** this file and `.cleanup-evidence/proposal-browser-proof.ts` (driver) only. No product-source, Git, PR, CI, or deploy changes.
- **Status:** prepared, **not executed here**. This worker did not run the driver, did not open a browser, and did not start a server. The primary inspects, registers, and executes it under the shared `heavy.lock`.
- Unit proof `d13d5385e71680429929ef82dc8e6bf2d1ce3e69610e8e8c676c3d13dc2b112e/2e9852da-b456-46b9-8415-d609b3e8b7e6` (`deno run --no-config --allow-read=proposal-router proposal-router/router.test.mjs`) was already executed by the primary and is **not** rerun or restated as this driver's result.
- Prior primary browser run: all real UI assertions passed and the screenshots were reviewed by 042, but the cleanup receipt was rejected as false. `sessionTouched` was never set true, so `99-cleanup` had zero assertions/no close command, and the absence check used `session list`, which returned `[]` while the exact session still reported `browserLaunched:true/pageCount:1`. The primary safely recovered that run (exact own `close` → `closed:true`, then `session info` → `browserLaunched:false/pageCount:0`; the owned daemon PID was terminated after ownership verification). The UI behavior evidence remains valid; this revision fixes the lifecycle mechanism and is to be rerun as the same registered target with a fresh reason.

## Registered command (run once, from the worktree root)

```
deno run --no-config --cached-only \
  --allow-read=proposal-router,.cleanup-evidence,/usr/bin/chromium \
  --allow-write=.cleanup-evidence/proposal-browser-proof \
  --allow-net=127.0.0.1:8138 \
  --allow-run=/home/codex/.local/bin/agent-browser \
  --allow-env=HOME,TMPDIR,PATH \
  .cleanup-evidence/proposal-browser-proof.ts
```

| Permission | Why it is needed |
| --- | --- |
| `--no-config --cached-only` | no `deno.json` inheritance; remote deps must already be cached (no install/fetch) |
| `--allow-read=proposal-router,.cleanup-evidence,/usr/bin/chromium` | serve only `proposal-router/`; stat/read own artifacts; preflight the Chromium binary |
| `--allow-write=.cleanup-evidence/proposal-browser-proof` | driver creates its own config, transcript, receipt, snapshots, screenshots |
| `--allow-net=127.0.0.1:8138` | bind the static server on loopback and run local HTTP MIME probes |
| `--allow-run=/home/codex/.local/bin/agent-browser` | spawn the installed CLI; no other executable |
| `--allow-env=HOME,TMPDIR,PATH` | read the three variables copied into the credential-free child env; values are never logged |

The driver's entry import is pinned to the cached `jsr:@std/http@1.0.21/file-server` (`serveDir`); `--cached-only` makes an evicted cache a hard failure instead of a network install. Total runtime is bounded by a 7-minute global budget plus per-command timeouts (open 90 s, others 30 s, hard SIGKILL on expiry). The two cleanup phases — `cleanup-close` (`close`) and `cleanup-session-after-close` (`session info`) — are the only commands exempt from that global deadline: they keep their own finite 30 s command timeouts and every safe-argument/session guard, so the owned browser is still closed and verified even when the main budget has expired. `sessionTouched` is set immediately before the owned `open` attempt, so a partial or failed open still reaches cleanup. Server abort/`await server.finished` shutdown remains unconditional.

## What the driver does (acceptance items 1–6 from the 038 handback)

1. **Setup/preflight:** create the task-owned evidence dir and an empty `{}` config (`--config` replaces user/project configs), verify cwd is the worktree root, verify frozen files exist, verify `agent-browser --version` = `0.36.0`, then read exact `session info` for namespace `uos-pr-cleanup-01a0c790` / session `proposal-router` and validate the reported namespace/session. Preflight **refuses** when that exact session reports a launched browser (`runtime.browserLaunched === true` or `runtime.pageCount > 0`) or unverifiable runtime metadata; an absent session or an idle own daemon is safe. `session list` is not used, because on 0.36.0 it returned `[]` while the exact session still had a launched browser.
2. **Server:** `Deno.serve` + `serveDir` on `127.0.0.1:8138` only, `fsRoot=proposal-router`, `urlRoot=proposal-router`; a busy port is a hard failure, never another port. Probes assert `/proposal-router/` (`text/html`), `main.js` (`javascript`), `styles.css` (`text/css`), `repositories.json` (`application/json`), and `/README.md` → 404 (nothing outside `proposal-router/` is served).
3. **Acceptance 1:** `open http://127.0.0.1:8138/proposal-router/`, wait for the rendered cards, capture `snapshot -i` (saved), and assert the initial auto-selected `ubiquity/pay.ubq.fi`, disabled issue link, and `Keyword match score: <n>` labels with no `%`.
4. **Acceptance 2:** fill query A, wait for the pay.ubq.fi href, and assert first suggestion + `#repository` = `ubiquity/pay.ubq.fi`, exact href, and decoded `title`/`body` round-trip.
5. **Acceptance 3:** `select #repository ubiquity/ubiquity-dollar`, assert the href retargets to ubiquity-dollar with the same fields.
6. **Acceptance 4:** fill query B; assert kernel ranks first, the manual selection stays `ubiquity/ubiquity-dollar`, the option list has 6 entries with ubiquity-dollar appended last (outside the top 5), and the href still points at ubiquity-dollar. Captures `snapshot -i` and the **normal screenshot**.
7. **Acceptance 5:** `reload`, assert the page is fresh, fill query B, and assert `#repository` auto-selects `ubiquity-os/ubiquity-os-kernel` with the kernel href and only 5 options.
8. **Acceptance 6:** install a controlled in-page `navigator.clipboard.writeText` stub (real `#copy-link` clicks, no synthetic clicks): first write resolves and captures the text → assert `Copied`, exactly one captured write, captured text exactly equals the href, href unchanged; then switch the stub to reject → assert `Copy failed`, second captured write, href unchanged, hint present. Captures the **failure-state screenshot** while `Copy failed` is on screen.

All browser interaction uses the installed CLI's documented commands (`open`, `fill`, `select`, `reload`, `click`, `wait --text`, `wait --fn`, `snapshot -i`, `screenshot`, `eval --stdin`, `session info`, `close`). Assertions run on real DOM state via `eval --stdin`; each eval returns a base64-marked JSON payload so the result is parsed independently of CLI output formatting.

## Safety properties (enforced in code, not just by convention)

- New namespace `uos-pr-cleanup-01a0c790` + session `proposal-router`; `--all` is refused. The foreign `default` and `prospector-load-audit` sessions are never referenced.
- No profile, restore, state, CDP, auto-connect, auth, provider, or plugin flags. Child env is exactly `HOME`, `PATH`, `TMPDIR` (credential-free); all other config is CLI flags with an explicit empty config.
- `click`/`dblclick` on `#issue-link` is refused; every absolute URL argument must start with `http://127.0.0.1:8138/`; no new tab/window. GitHub is only ever an `href` string read from the DOM — `Open GitHub Issue` is never clicked and no github.com request is made.
- `#copy-link` is clicked with real browser input; the clipboard stub only replaces `navigator.clipboard` in the page and suppresses the cosmetic 1400 ms label-reset timer so `Copied`/`Copy failed` remain stable for the assertions and screenshot.
- The owned session is closed only inside `finally` (after `sessionTouched` is set immediately before the owned `open` attempt), followed by an exact `session info` check for the owned namespace/session requiring `runtime.browserLaunched === false` and `runtime.pageCount === 0`, or a truly inactive/absent runtime. `close` proves no launched browser/page remains, **not** daemon-process termination, and `active` in `session info` is daemon activity, not browser liveness. The static server is shut down (abort + `await server.finished`) in the same cleanup path even when an assertion throws or the main global budget has expired (the two cleanup commands bypass only that budget, not safe-argument/session guards or their own finite timeouts).
- Every invocation's argv/exit/stdout/stderr is retained in `transcript.jsonl`; failures are thrown, never filtered into a green result.

## Expected artifacts (all under `.cleanup-evidence/proposal-browser-proof/`)

| Artifact | Content |
| --- | --- |
| `receipt.json` | outcome, steps + every assertion (expected/actual), server/browser config, pre/post-close exact-session lifecycle metadata (`status`, `session`, `namespace`, `active`, `pid`, `browserLaunched`, `pageCount`), artifact hashes, notes, errors |
| `transcript.jsonl` | one record per agent-browser invocation: phase, argv, exit code, timeout, stdout, stderr, duration |
| `agent-browser.config.json` | the empty `{}` config passed via `--config` |
| `snapshot-initial.json` | raw `snapshot -i --json` of the freshly opened page |
| `snapshot-query-b.json` | raw `snapshot -i --json` after query B with the pinned manual selection |
| `screenshot-normal.png` | normal state after query B (kernel suggestions + pinned ubiquity-dollar) |
| `screenshot-copy-failed.png` | failure state with the `Copy failed` label visible |

## Facts verified in this worker (static/local only; no browser, no server)

- `pwd`/branch/status: correct lane, untracked `proposal-router/` + `.cleanup-evidence/`, HEAD at the assigned base.
- `agent-browser 0.36.0` at the stated path, Chromium `153.0.8010.36` at `/usr/bin/chromium`.
- `agent-browser --namespace uos-pr-cleanup-01a0c790 --json session list` → `{"success":true,"data":{"sessions":[]}}` at preparation time. This observation is retained only as non-authoritative: the primary's run proved that on installed 0.36.0 `session list` can return `[]` while the exact session still has a launched browser, so the driver's lifecycle checks now use `session info` runtime metadata instead.
- `jsr:@std/http@1.0.21/file-server` imports with `deno eval --cached-only` (fully cached closure).
- Spawning the CLI through `Deno.Command` with `--allow-run=<symlink path>`, `clearEnv: true`, and the three-variable env works (`--version` exit 0).
- The full global flag set used by the driver (`--namespace`, `--session`, `--config {}`, `--executable-path`, `--allowed-domains`, `--no-webmcp`, `--json`) is accepted; the driver type-checks with `deno check --no-config --cached-only` (exit 0), and the expected-URL/marker logic round-trips exactly (query A URL byte-equal to the 038 handback string).

## Remaining risks (for the primary's one permitted correction handback)

1. `--allowed-domains` is documented to require a fresh controllable context. The driver passes no profile/restore/state/CDP/auto-connect flags, but if agent-browser 0.36.0 rejects the combination, `open` fails loudly and the correction is to drop the flag (the guard already refuses non-local URL arguments, so containment remains).
2. First Chromium launch under the scrubbed three-variable env on this host is unverified by this worker (existing sessions belong to others). If Chromium needs an extra documented variable, the correction is to add that variable name to the child env and to `--allow-env`.
3. The agent-browser daemon writes its namespace/socket state under `$HOME`/`$TMPDIR`; the DSH file sandbox must permit that for the primary's run. This worker confirmed both `$HOME/.agent-browser` and `/tmp` are writable to the `codex` user.
4. Exact `data` shapes for some CLI commands are parsed leniently (last-JSON-line envelope + base64 marker), but `success: true` and exit code 0 are always required; a shape mismatch fails closed rather than fabricating a pass.
5. Port 8138 must still be free when the primary executes; the driver fails on bind instead of choosing another port, so a busy port requires a re-confirmed port decision.
