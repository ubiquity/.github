/**
 * 040-proposal-browser-proof — bounded real-browser acceptance driver for proposal-router.
 *
 * The primary runs this once, from the worktree root, under the shared heavy lock:
 *
 *   deno run --no-config --cached-only \
 *     --allow-read=proposal-router,.cleanup-evidence,/usr/bin/chromium \
 *     --allow-write=.cleanup-evidence/proposal-browser-proof \
 *     --allow-net=127.0.0.1:8138 \
 *     --allow-run=/home/codex/.local/bin/agent-browser \
 *     --allow-env=HOME,TMPDIR,PATH \
 *     .cleanup-evidence/proposal-browser-proof.ts
 *
 * What it proves (acceptance items 1-6 of the 038 handback):
 *   1. the real local page opens and its interactive accessibility tree is captured;
 *   2. query A auto-selects ubiquity/pay.ubq.fi and the issue URL round-trips title/body;
 *   3. a manual ubiquity/ubiquity-dollar selection retargets the issue URL;
 *   4. query B keeps the manual selection even when it drops out of the top 5 (appended option),
 *      the kernel ranks first, and the href still points at ubiquity/ubiquity-dollar;
 *   5. after a reload, query B auto-selects ubiquity-os/ubiquity-os-kernel;
 *   6. a controlled in-page clipboard stub captures the exact copied text (resolve) and then
 *      rejects, and the real #copy-link click shows Copied / Copy failed without arbitrary sleeps.
 *
 * Safety contract enforced here:
 *   - only namespace uos-pr-cleanup-01a0c790 / session proposal-router is used; `--all` is refused;
 *   - no profile, restore, state, CDP, auto-connect, auth, or provider flags are ever passed;
 *   - navigation is refused unless it targets the local 127.0.0.1:8138 server; #issue-link is never clicked;
 *   - the static server binds only 127.0.0.1:8138 (a busy port is a hard failure, never a different port)
 *     and serves only proposal-router/ with std/http serveDir;
 *   - the owned session is closed in `finally` and the server is shut down in `finally`;
 *   - every agent-browser invocation is time-bounded and its argv/exit/stdout/stderr is retained.
 *
 * This driver does not rerun unit tests and does not claim unit/model results.
 */

import { serveDir } from "jsr:@std/http@1.0.21/file-server";
import { dirname, join } from "node:path";

const WORKER_ID = "040-proposal-browser-proof";
const AGENT_BROWSER = "/home/codex/.local/bin/agent-browser";
const CHROMIUM = "/usr/bin/chromium";
const NAMESPACE = "uos-pr-cleanup-01a0c790";
const SESSION = "proposal-router";
const HOST = "127.0.0.1";
const PORT = 8138;
const ALLOWED_DOMAINS = "127.0.0.1,localhost";
const ORIGIN = `http://${HOST}:${PORT}`;
const BASE_URL = `${ORIGIN}/proposal-router/`;

const QUERY_A =
  "Fix the cash out interface on pay.ubq.fi because the claim screen is not centered.";
const QUERY_B =
  "Route a new webhook command to the correct plugin in the kernel.";

const REGISTERED_COMMAND = [
  "deno run --no-config --cached-only",
  "--allow-read=proposal-router,.cleanup-evidence,/usr/bin/chromium",
  "--allow-write=.cleanup-evidence/proposal-browser-proof",
  "--allow-net=127.0.0.1:8138",
  `--allow-run=${AGENT_BROWSER}`,
  "--allow-env=HOME,TMPDIR,PATH",
  ".cleanup-evidence/proposal-browser-proof.ts",
].join(" ");

const HERE_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const ROOT_DIR = dirname(HERE_DIR);
const ROUTER_DIR = join(ROOT_DIR, "proposal-router");
const EVIDENCE_DIR = join(HERE_DIR, "proposal-browser-proof");
const CONFIG_PATH = join(EVIDENCE_DIR, "agent-browser.config.json");
const TRANSCRIPT_PATH = join(EVIDENCE_DIR, "transcript.jsonl");
const RECEIPT_PATH = join(EVIDENCE_DIR, "receipt.json");
const SNAPSHOT_INITIAL_PATH = join(EVIDENCE_DIR, "snapshot-initial.json");
const SNAPSHOT_QUERY_B_PATH = join(EVIDENCE_DIR, "snapshot-query-b.json");
const SCREENSHOT_NORMAL_PATH = join(EVIDENCE_DIR, "screenshot-normal.png");
const SCREENSHOT_FAILURE_PATH = join(
  EVIDENCE_DIR,
  "screenshot-copy-failed.png",
);

const DEFAULT_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 90_000;
const GLOBAL_BUDGET_MS = 7 * 60_000;
const STARTED_AT = Date.now();
const DEADLINE = STARTED_AT + GLOBAL_BUDGET_MS;

const HOME_DIR = Deno.env.get("HOME");
if (!HOME_DIR) {
  throw new Error(
    "HOME is required to build the credential-free agent-browser child environment",
  );
}

// Minimal credential-free child environment: exactly PATH/HOME/TMPDIR. All other
// configuration is passed as documented CLI flags (`--config` replaces user/project configs).
const CHILD_ENV: Record<string, string> = {
  HOME: HOME_DIR,
  PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin",
  TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
};

const GLOBALS = [
  "--namespace",
  NAMESPACE,
  "--session",
  SESSION,
  "--config",
  CONFIG_PATH,
  "--executable-path",
  CHROMIUM,
  "--allowed-domains",
  ALLOWED_DOMAINS,
  "--no-webmcp",
  "--json",
];

interface AssertionRecord {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
  detail?: string;
}

interface StepRecord {
  id: string;
  description: string;
  status: "running" | "passed" | "failed";
  assertions: AssertionRecord[];
  error?: string;
  durationMs?: number;
}

interface TranscriptRecord {
  seq: number;
  phase: string;
  argv: string[];
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  timeoutMs: number;
  stdout: string;
  stderr: string;
}

interface CliResult {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface BrowserResult {
  result: CliResult;
  envelope: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface ArtifactRecord {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Exact-session lifecycle metadata from `session info`. `active` is daemon
 * activity, not browser liveness: only `runtime.browserLaunched` and
 * `runtime.pageCount` describe whether a browser/page is still up.
 */
interface OwnedSessionState {
  status:
    | "absent-runtime"
    | "inactive-runtime"
    | "idle"
    | "launched"
    | "unknown";
  exitCode: number;
  timedOut: boolean;
  session: string | null;
  namespace: string | null;
  active: boolean | null;
  pid: number | null;
  browserLaunched: boolean | null;
  pageCount: number | null;
  runtimeReported: boolean;
  detail: string;
}

interface StaticServerHandle {
  server: Deno.HttpServer<Deno.NetAddr>;
  controller: AbortController;
}

class ProofFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofFailure";
  }
}

const steps: StepRecord[] = [];
const transcript: TranscriptRecord[] = [];
const artifacts: Record<string, ArtifactRecord> = {};
const notes: string[] = [
  "Unit proof ref d13d5385e71680429929ef82dc8e6bf2d1ce3e69610e8e8c676c3d13dc2b112e/2e9852da-b456-46b9-8415-d609b3e8b7e6 was executed by the primary before this driver; this driver does not rerun it.",
  "Clipboard evidence uses a controlled in-page `navigator.clipboard.writeText` stub (installed via agent-browser eval) so success and rejection are deterministic and credential-free. The real #copy-link click handler and real Clipboard API call path run unchanged.",
  "The stub also suppresses only the cosmetic 1400 ms `Copy Link` label reset timer so `Copied` / `Copy failed` stay stable for the assertions and the failure screenshot; the reset behavior itself is not part of the required acceptance.",
  "The GitHub issue URL is only read from the DOM; `Open GitHub Issue` is never clicked, no github.com request is made, and proposal text is synthetic.",
  "Cleanup evidence uses exact `session info` runtime metadata for this owned namespace/session. On agent-browser 0.36.0, `session list` returned [] while the exact session still reported browserLaunched:true/pageCount:1, so list is not an authoritative absence check. `sessionTouched` is set immediately before the owned open attempt, so a partial or failed open still reaches cleanup.",
];

let staticServer: StaticServerHandle | null = null;
let serverStarted = false;
let serverStopped = false;
let sessionTouched = false;
let preflightOwnedSession: OwnedSessionState | null = null;
let postCloseOwnedSession: OwnedSessionState | null = null;

let mainError: Error | null = null;
let cleanupError: Error | null = null;
let closeError: Error | null = null;
let postCloseError: Error | null = null;
let serverError: Error | null = null;
let receiptError: Error | null = null;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function short(value: unknown, limit = 400): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left === "object" && typeof right === "object" && left !== null &&
    right !== null
  ) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  return false;
}

function currentStep(): StepRecord {
  const step = steps.at(-1);
  if (!step) throw new Error("assertion recorded outside of a step");
  return step;
}

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = sameValue(actual, expected);
  currentStep().assertions.push({ name, expected, actual, ok });
  if (!ok) {
    throw new ProofFailure(
      `assertion failed: ${name} — expected ${short(expected)}, got ${
        short(actual)
      }`,
    );
  }
}

function checkTrue(name: string, ok: boolean, detail?: unknown): void {
  currentStep().assertions.push({
    name,
    expected: true,
    actual: ok,
    ok,
    detail: detail === undefined ? undefined : short(detail),
  });
  if (!ok) {
    throw new ProofFailure(
      `assertion failed: ${name}${
        detail === undefined ? "" : ` — ${short(detail)}`
      }`,
    );
  }
}

function checkMatch(name: string, actual: unknown, pattern: RegExp): void {
  const ok = typeof actual === "string" && pattern.test(actual);
  currentStep().assertions.push({ name, expected: pattern.source, actual, ok });
  if (!ok) {
    throw new ProofFailure(
      `assertion failed: ${name} — ${short(actual)} does not match ${pattern}`,
    );
  }
}

function note(message: string): void {
  notes.push(message);
}

function beginStep(id: string, description: string): StepRecord {
  const record: StepRecord = {
    id,
    description,
    status: "running",
    assertions: [],
  };
  steps.push(record);
  return record;
}

async function step(
  id: string,
  description: string,
  body: () => Promise<void>,
): Promise<void> {
  const record = beginStep(id, description);
  const startedAt = Date.now();
  try {
    await body();
    record.status = "passed";
    console.log(`[${WORKER_ID}] ${id} passed`);
  } catch (error) {
    record.status = "failed";
    record.error = errorMessage(error);
    console.error(`[${WORKER_ID}] ${id} FAILED: ${record.error}`);
    throw error;
  } finally {
    record.durationMs = Date.now() - startedAt;
  }
}

function assertBudget(): void {
  if (Date.now() > DEADLINE) {
    throw new Error(
      `global time budget of ${GLOBAL_BUDGET_MS} ms exceeded; refusing to keep driving the browser`,
    );
  }
}

/**
 * Refuse anything that could navigate off the local page, touch another session,
 * or click the GitHub issue link. This is a fail-closed guard, not a filter.
 */
function assertSafeArgs(args: string[]): void {
  const [command, ...rest] = args;
  if (args.includes("--all")) {
    throw new Error(`refusing --all cleanup in: ${args.join(" ")}`);
  }
  if (
    command === "connect" || args.includes("--cdp") ||
    args.includes("--auto-connect")
  ) {
    throw new Error(`refusing CDP/auto-connect command: ${args.join(" ")}`);
  }
  if (
    command === "open" || command === "goto" || command === "navigate" ||
    command === "pushstate"
  ) {
    const target = rest.find((argument) => !argument.startsWith("-"));
    if (target !== BASE_URL) {
      throw new Error(
        `refusing navigation to ${short(target)}; only ${BASE_URL} is allowed`,
      );
    }
  }
  if ((command === "tab" || command === "window") && rest[0] === "new") {
    throw new Error("refusing to open a new tab/window");
  }
  if (command === "click" || command === "dblclick") {
    if (rest.some((argument) => argument.includes("issue-link"))) {
      throw new Error("refusing to click #issue-link");
    }
  }
  for (const argument of args) {
    if (/^https?:\/\//i.test(argument) && !argument.startsWith(`${ORIGIN}/`)) {
      throw new Error(
        `refusing non-local absolute URL argument: ${short(argument)}`,
      );
    }
  }
}

async function execCli(
  argv: string[],
  options: {
    phase: string;
    timeoutMs: number;
    stdin?: string;
    ignoreGlobalDeadline?: boolean;
  },
): Promise<CliResult> {
  // Cleanup must still close the owned browser after the main 7-minute budget
  // expires. Only the two cleanup phases set ignoreGlobalDeadline; they keep
  // their own finite command timeout and all safe-argument/session guards.
  if (!options.ignoreGlobalDeadline) assertBudget();
  const startedAt = Date.now();
  const command = new Deno.Command(AGENT_BROWSER, {
    args: argv,
    env: CHILD_ENV,
    clearEnv: true,
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = (() => {
    try {
      return command.spawn();
    } catch (error) {
      transcript.push({
        seq: transcript.length + 1,
        phase: options.phase,
        argv,
        code: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        stdout: "",
        stderr: `spawn failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  })();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child already exited; the timeout record still marks the command as timed out.
    }
  }, options.timeoutMs);

  try {
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    const output = await child.output();
    const durationMs = Date.now() - startedAt;
    const result: CliResult = {
      argv,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      durationMs,
      timedOut,
    };
    transcript.push({
      seq: transcript.length + 1,
      phase: options.phase,
      argv,
      code: result.code,
      timedOut,
      durationMs,
      timeoutMs: options.timeoutMs,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const candidates: string[] = [];
  if (trimmed) candidates.push(trimmed);
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(
    Boolean,
  );
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    candidates.push(lines[index]);
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate line.
    }
  }
  throw new Error(
    `agent-browser did not return a JSON envelope; stdout head: ${
      short(stdout, 400)
    }`,
  );
}

function envelopeData(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const data = envelope.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

async function runBrowser(
  args: string[],
  phase: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdin?: string,
  ignoreGlobalDeadline = false,
): Promise<BrowserResult> {
  assertSafeArgs(args);
  const result = await execCli([...GLOBALS, ...args], {
    phase,
    timeoutMs,
    stdin,
    ignoreGlobalDeadline,
  });
  if (result.timedOut) {
    throw new Error(
      `agent-browser ${phase} timed out after ${timeoutMs} ms; stderr: ${
        short(result.stderr, 300)
      }`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `agent-browser ${phase} exited with code ${result.code}; stderr: ${
        short(result.stderr, 300)
      }; stdout: ${short(result.stdout, 200)}`,
    );
  }
  const envelope = parseEnvelope(result.stdout);
  if (envelope.success !== true) {
    throw new Error(
      `agent-browser ${phase} reported success:false; envelope: ${
        short(envelope, 400)
      }`,
    );
  }
  return { result, envelope, data: envelopeData(envelope) };
}

function readEvalMarker(stdout: string): unknown {
  const match = stdout.match(/PRF1:([A-Za-z0-9+/=]+)/);
  if (!match) {
    throw new Error(
      `eval result marker PRF1 was not found in agent-browser output; stdout head: ${
        short(stdout, 400)
      }`,
    );
  }
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0)),
  );
  return JSON.parse(json);
}

async function evalJson(
  phase: string,
  body: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const script = [
    "(() => {",
    "  const __payload = (() => {",
    body,
    "  })();",
    "  const __bytes = new TextEncoder().encode(JSON.stringify(__payload));",
    '  let __binary = "";',
    "  for (const __byte of __bytes) __binary += String.fromCharCode(__byte);",
    '  return "PRF1:" + btoa(__binary);',
    "})()",
  ].join("\n");
  const { result } = await runBrowser(
    ["eval", "--stdin"],
    phase,
    timeoutMs,
    script,
  );
  const marker = readEvalMarker(result.stdout);
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error(
      `eval ${phase} returned a non-object payload: ${short(marker)}`,
    );
  }
  return marker as Record<string, unknown>;
}

/**
 * Read exact lifecycle metadata for the owned namespace/session. `session list`
 * is deliberately not used: on agent-browser 0.36.0 it returned [] while this
 * exact session still reported browserLaunched:true/pageCount:1.
 */
async function readOwnedSessionState(
  phase: string,
  ignoreGlobalDeadline = false,
): Promise<OwnedSessionState> {
  assertSafeArgs(["session", "info"]);
  const result = await execCli([...GLOBALS, "session", "info"], {
    phase,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ignoreGlobalDeadline,
  });
  if (result.timedOut) {
    throw new Error(
      `agent-browser ${phase} timed out after ${DEFAULT_TIMEOUT_MS} ms; stderr: ${
        short(result.stderr, 300)
      }`,
    );
  }
  let envelope: Record<string, unknown> | null = null;
  try {
    envelope = parseEnvelope(result.stdout);
  } catch {
    envelope = null;
  }
  const data = envelope ? envelopeData(envelope) : {};
  const runtimeValue = data.runtime;
  const runtime = runtimeValue !== null && typeof runtimeValue === "object"
    ? runtimeValue as Record<string, unknown>
    : null;
  const runtimeReported = runtime !== null;
  const browserLaunched =
    runtime && typeof runtime.browserLaunched === "boolean"
      ? runtime.browserLaunched
      : null;
  const pageCount = runtime && typeof runtime.pageCount === "number"
    ? runtime.pageCount
    : null;
  const active = typeof data.active === "boolean" ? data.active : null;
  const pid = typeof data.pid === "number" ? data.pid : null;
  const session = typeof data.session === "string"
    ? data.session
    : (typeof data.sessionName === "string" ? data.sessionName : null);
  const namespace = typeof data.namespace === "string" ? data.namespace : null;

  let status: OwnedSessionState["status"];
  if (result.code !== 0 || (envelope === null && result.stdout.trim() === "")) {
    status = "absent-runtime";
  } else if (envelope === null) {
    status = "unknown";
  } else if (envelope.success !== true) {
    status = "absent-runtime";
  } else if (browserLaunched === true || (pageCount !== null && pageCount > 0)) {
    status = "launched";
  } else if (browserLaunched === false && pageCount === 0) {
    status = "idle";
  } else if (!runtimeReported && active !== true) {
    status = "inactive-runtime";
  } else {
    status = "unknown";
  }

  return {
    status,
    exitCode: result.code,
    timedOut: false,
    session,
    namespace,
    active,
    pid,
    browserLaunched,
    pageCount,
    runtimeReported,
    detail: short(
      envelope
        ? { success: envelope.success, data }
        : { stdout: result.stdout, stderr: result.stderr },
      600,
    ),
  };
}

function expectedIssueUrl(
  repositoryKey: string,
  title: string,
  body: string,
): string {
  return `https://github.com/${repositoryKey}/issues/new?${
    new URLSearchParams({ title: title.trim(), body: body.trim() }).toString()
  }`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function relativePath(path: string): string {
  return path.startsWith(`${ROOT_DIR}/`)
    ? path.slice(ROOT_DIR.length + 1)
    : path;
}

async function recordArtifact(
  key: string,
  path: string,
): Promise<ArtifactRecord> {
  const info = await Deno.stat(path);
  const bytes = await Deno.readFile(path);
  const record: ArtifactRecord = {
    path: relativePath(path),
    bytes: info.size,
    sha256: await sha256(bytes),
  };
  artifacts[key] = record;
  return record;
}

async function checkPngArtifact(name: string, path: string): Promise<void> {
  const info = await Deno.stat(path);
  checkTrue(`${name} exists`, info.isFile);
  checkTrue(`${name} is non-empty`, info.size > 0, info.size);
  const bytes = await Deno.readFile(path);
  const isPng = bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  checkTrue(`${name} has a PNG signature`, isPng);
  artifacts[name] = {
    path: relativePath(path),
    bytes: info.size,
    sha256: await sha256(bytes),
  };
}

async function startStaticServer(): Promise<StaticServerHandle> {
  let markListening: (() => void) | undefined;
  const listening = new Promise<void>((resolve) => {
    markListening = resolve;
  });
  const controller = new AbortController();
  const server = Deno.serve(
    {
      hostname: HOST,
      port: PORT,
      signal: controller.signal,
      onListen: () => markListening?.(),
    },
    (request: Request) =>
      serveDir(request, {
        fsRoot: ROUTER_DIR,
        urlRoot: "proposal-router",
        showIndex: true,
        showDirListing: false,
        showDotfiles: false,
        quiet: true,
      }),
  );
  const finished = server.finished.then(
    () => ({ kind: "closed" as const }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const outcome = await Promise.race([
    listening.then(() => ({ kind: "listening" as const })),
    finished,
  ]);
  if (outcome.kind !== "listening") {
    controller.abort();
    const reason = outcome.kind === "error"
      ? errorMessage(outcome.error)
      : "server closed before it reported listening";
    throw new Error(
      `static server failed to bind ${HOST}:${PORT} (${reason}); refusing to select another port`,
    );
  }
  return { server, controller };
}

async function stopStaticServer(): Promise<void> {
  if (!staticServer) return;
  staticServer.controller.abort();
  await staticServer.server.finished.catch(() => {});
  staticServer = null;
  serverStopped = true;
}

async function probeHttp(
  pathname: string,
  expectedStatus: number,
  expectedContentType?: string,
): Promise<void> {
  const response = await fetch(`${ORIGIN}${pathname}`, { redirect: "manual" });
  await response.arrayBuffer();
  check(`GET ${pathname} status`, response.status, expectedStatus);
  if (expectedContentType) {
    const contentType = response.headers.get("content-type") ?? "";
    checkTrue(
      `GET ${pathname} content-type contains ${expectedContentType}`,
      contentType.includes(expectedContentType),
      contentType,
    );
  }
}

const CAPTURE_STATE_BODY = `
      const element = (selector) => document.querySelector(selector);
      const link = element("#issue-link");
      const url = new URL(link.href);
      return {
        location: location.href,
        href: link.href,
        hrefAttribute: link.getAttribute("href"),
        ariaDisabled: link.getAttribute("aria-disabled"),
        decodedTitle: url.searchParams.get("title"),
        decodedBody: url.searchParams.get("body"),
        titleValue: element("#title").value,
        proposalValue: element("#proposal").value,
        selectValue: element("#repository").value,
        selectOptions: Array.from(element("#repository").options, (option) => option.value),
        suggestions: Array.from(document.querySelectorAll("#suggestions li"), (item) => {
          const strong = item.querySelector("strong");
          return strong ? strong.textContent ?? "" : "";
        }),
        scores: Array.from(document.querySelectorAll("#suggestions li span"), (item) => item.textContent ?? ""),
        copyLabel: element("#copy-link").textContent ?? "",
        bodyText: document.body.innerText,
      };
`;

const CLIPBOARD_STATE_BODY = `
      const proof = window.__proof;
      const link = document.querySelector("#issue-link");
      const button = document.querySelector("#copy-link");
      return {
        location: location.href,
        label: button.textContent ?? "",
        hint: button.title ?? "",
        href: link.href,
        ariaDisabled: link.getAttribute("aria-disabled"),
        mode: proof ? proof.mode : null,
        calls: proof ? proof.calls.slice() : [],
        resetSuppressed: proof ? proof.resetSuppressed : false,
      };
`;

const CLIPBOARD_INSTALL_BODY = `
      const link = document.querySelector("#issue-link");
      const realSetTimeout = window.setTimeout.bind(window);
      window.__proof = { calls: [], mode: "resolve", resetSuppressed: false };
      window.setTimeout = function (callback, delay, ...rest) {
        if (delay === 1400) {
          window.__proof.resetSuppressed = true;
          return 0;
        }
        return realSetTimeout(callback, delay, ...rest);
      };
      const stub = {
        writeText(text) {
          window.__proof.calls.push(String(text));
          if (window.__proof.mode === "reject") {
            return Promise.reject(new Error("proposal-browser-proof: stubbed clipboard rejection"));
          }
          return Promise.resolve();
        },
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        get() {
          return stub;
        },
      });
      return {
        installed: Boolean(navigator.clipboard?.writeText),
        href: link.href,
        ariaDisabled: link.getAttribute("aria-disabled"),
      };
`;

function snapshotText(data: Record<string, unknown>, stdout: string): string {
  const snapshot = data.snapshot;
  if (typeof snapshot === "string" && snapshot.length > 0) return snapshot;
  return stdout;
}

async function main(): Promise<void> {
  await step(
    "00-setup",
    "create the task-owned evidence directory and isolated empty agent-browser config",
    async () => {
      await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
      await Deno.writeTextFile(CONFIG_PATH, "{}\n");
      const raw = await Deno.readTextFile(CONFIG_PATH);
      check("agent-browser config is an empty JSON object", raw.trim(), "{}");
      await recordArtifact("agent-browser-config", CONFIG_PATH);
    },
  );

  await step(
    "01-preflight",
    "verify host tools, worktree root, and that this namespace has no existing owned session",
    async () => {
      check("driver cwd is the worktree root", Deno.cwd(), ROOT_DIR);
      for (
        const file of [
          "index.html",
          "main.js",
          "router.js",
          "styles.css",
          "repositories.json",
        ]
      ) {
        const info = await Deno.stat(join(ROUTER_DIR, file));
        checkTrue(`proposal-router/${file} exists`, info.isFile);
      }
      const chromiumInfo = await Deno.stat(CHROMIUM);
      checkTrue("chromium executable exists", chromiumInfo.isFile);
      const version = await execCli(["--version"], {
        phase: "agent-browser-version",
        timeoutMs: 15_000,
      });
      check("agent-browser --version exit code", version.code, 0);
      check(
        "agent-browser version",
        version.stdout.trim(),
        "agent-browser 0.36.0",
      );
      preflightOwnedSession = await readOwnedSessionState(
        "session-info-preflight",
      );
      if (preflightOwnedSession.session !== null) {
        check(
          "preflight session info reports the owned session",
          preflightOwnedSession.session,
          SESSION,
        );
      }
      if (preflightOwnedSession.namespace !== null) {
        check(
          "preflight session info reports the owned namespace",
          preflightOwnedSession.namespace,
          NAMESPACE,
        );
      }
      checkTrue(
        `preflight found no launched browser for ${NAMESPACE}/${SESSION} (absent or idle own daemon is safe)`,
        preflightOwnedSession.status === "absent-runtime" ||
          preflightOwnedSession.status === "inactive-runtime" ||
          preflightOwnedSession.status === "idle",
        preflightOwnedSession,
      );
    },
  );

  await step(
    "02-static-server",
    "bind 127.0.0.1:8138, serve only proposal-router/, and verify MIME types",
    async () => {
      staticServer = await startStaticServer();
      serverStarted = true;
      await probeHttp("/proposal-router/", 200, "text/html");
      await probeHttp("/proposal-router/main.js", 200, "javascript");
      await probeHttp("/proposal-router/styles.css", 200, "text/css");
      await probeHttp(
        "/proposal-router/repositories.json",
        200,
        "application/json",
      );
      await probeHttp("/README.md", 404);
    },
  );

  await step(
    "03-open-and-snapshot",
    "acceptance 1: open the real local page and snapshot the interactive tree",
    async () => {
      // Mark the owned session as touched immediately before the open attempt:
      // a partial or failed open must still run the finally cleanup path.
      sessionTouched = true;
      await runBrowser(["open", BASE_URL], "open", OPEN_TIMEOUT_MS);
      await runBrowser(
        [
          "wait",
          "--fn",
          "document.querySelectorAll('#suggestions li').length === 5",
        ],
        "initial-render",
      );
      const snapshot = await runBrowser(["snapshot", "-i"], "initial-snapshot");
      await Deno.writeTextFile(SNAPSHOT_INITIAL_PATH, snapshot.result.stdout);
      await recordArtifact("snapshot-initial", SNAPSHOT_INITIAL_PATH);
      const tree = snapshotText(snapshot.data, snapshot.result.stdout);
      checkTrue("interactive snapshot tree is non-empty", tree.length > 0);
      checkTrue(
        "interactive snapshot contains the pay.ubq.fi card",
        tree.includes("ubiquity/pay.ubq.fi"),
      );
      checkTrue(
        "interactive snapshot contains the Copy Link button",
        tree.includes("Copy Link"),
      );
      checkTrue(
        "interactive snapshot contains the Open GitHub Issue link",
        tree.includes("Open GitHub Issue"),
      );

      const state = await evalJson("initial-state", CAPTURE_STATE_BODY);
      check("initial location", state.location, BASE_URL);
      check(
        "initial suggestion count",
        (state.suggestions as unknown[]).length,
        5,
      );
      check(
        "initial first suggestion",
        (state.suggestions as unknown[])[0],
        "ubiquity/pay.ubq.fi",
      );
      check(
        "initial auto-selected repository",
        state.selectValue,
        "ubiquity/pay.ubq.fi",
      );
      check("initial issue link is disabled", state.ariaDisabled, "true");
      check("initial issue link href placeholder", state.hrefAttribute, "#");
      checkTrue(
        "initial score labels are keyword match scores without percent claims",
        (state.scores as unknown[]).length === 5 &&
          (state.scores as unknown[]).every((score) =>
            typeof score === "string" &&
            /^Keyword match score: \d+$/.test(score)
          ),
        state.scores,
      );
      checkTrue(
        "initial page text contains no percent sign",
        !String(state.bodyText).includes("%"),
      );
    },
  );

  await step(
    "04-query-a",
    "acceptance 2: query A auto-selects pay.ubq.fi and round-trips title/body",
    async () => {
      await runBrowser(["fill", "#proposal", QUERY_A], "query-a-fill");
      await runBrowser(
        [
          "wait",
          "--fn",
          "document.querySelector('#issue-link').href.startsWith('https://github.com/ubiquity/pay.ubq.fi/issues/new')",
        ],
        "query-a-href",
      );
      const state = await evalJson("query-a-state", CAPTURE_STATE_BODY);
      const expected = expectedIssueUrl(
        "ubiquity/pay.ubq.fi",
        QUERY_A,
        QUERY_A,
      );
      check(
        "query A first suggestion",
        (state.suggestions as unknown[])[0],
        "ubiquity/pay.ubq.fi",
      );
      check(
        "query A auto-selected repository",
        state.selectValue,
        "ubiquity/pay.ubq.fi",
      );
      check("query A auto-filled title", state.titleValue, QUERY_A);
      check("query A issue href", state.href, expected);
      check("query A decoded title", state.decodedTitle, QUERY_A);
      check("query A decoded body", state.decodedBody, QUERY_A);
      check("query A issue link enabled", state.ariaDisabled, "false");
      check("query A location unchanged", state.location, BASE_URL);
    },
  );

  await step(
    "05-manual-selection",
    "acceptance 3: manual ubiquity/ubiquity-dollar selection retargets the issue URL",
    async () => {
      await runBrowser(
        ["select", "#repository", "ubiquity/ubiquity-dollar"],
        "select-ubiquity-dollar",
      );
      const state = await evalJson(
        "manual-selection-state",
        CAPTURE_STATE_BODY,
      );
      check(
        "manual selection value",
        state.selectValue,
        "ubiquity/ubiquity-dollar",
      );
      check("manual selection keeps title", state.decodedTitle, QUERY_A);
      check("manual selection keeps body", state.decodedBody, QUERY_A);
      check(
        "manual selection retargets issue href",
        state.href,
        expectedIssueUrl("ubiquity/ubiquity-dollar", QUERY_A, QUERY_A),
      );
      checkTrue(
        "manual selection option is offered",
        (state.selectOptions as unknown[]).includes("ubiquity/ubiquity-dollar"),
      );
    },
  );

  await step(
    "06-query-b-pinned",
    "acceptance 4: query B ranks the kernel first but keeps the out-of-top-5 manual selection",
    async () => {
      await runBrowser(["fill", "#proposal", QUERY_B], "query-b-fill");
      await runBrowser(
        [
          "wait",
          "--fn",
          "document.querySelector('#issue-link').href.startsWith('https://github.com/ubiquity/ubiquity-dollar/issues/new')",
        ],
        "query-b-href",
      );
      const state = await evalJson("query-b-state", CAPTURE_STATE_BODY);
      const expected = expectedIssueUrl(
        "ubiquity/ubiquity-dollar",
        QUERY_B,
        QUERY_B,
      );
      check(
        "query B first suggestion",
        (state.suggestions as unknown[])[0],
        "ubiquity-os/ubiquity-os-kernel",
      );
      check(
        "query B suggestion count",
        (state.suggestions as unknown[]).length,
        5,
      );
      check(
        "query B keeps manual repository selected",
        state.selectValue,
        "ubiquity/ubiquity-dollar",
      );
      check(
        "query B option count includes the appended manual selection",
        (state.selectOptions as unknown[]).length,
        6,
      );
      check(
        "query B manual selection is appended last",
        (state.selectOptions as unknown[])[5],
        "ubiquity/ubiquity-dollar",
      );
      checkTrue(
        "query B manual selection is outside the top 5 ranked options",
        !(state.selectOptions as unknown[]).slice(0, 5).includes(
          "ubiquity/ubiquity-dollar",
        ),
        state.selectOptions,
      );
      check(
        "query B href stays on the manual repository",
        state.href,
        expected,
      );
      check("query B decoded title round-trip", state.decodedTitle, QUERY_B);
      check("query B decoded body round-trip", state.decodedBody, QUERY_B);
      check("query B auto-filled title", state.titleValue, QUERY_B);
      check("query B location unchanged", state.location, BASE_URL);
    },
  );

  await step(
    "07-normal-evidence",
    "capture the re-ranked interactive snapshot and the normal screenshot",
    async () => {
      const snapshot = await runBrowser(["snapshot", "-i"], "query-b-snapshot");
      await Deno.writeTextFile(SNAPSHOT_QUERY_B_PATH, snapshot.result.stdout);
      await recordArtifact("snapshot-query-b", SNAPSHOT_QUERY_B_PATH);
      const tree = snapshotText(snapshot.data, snapshot.result.stdout);
      checkTrue(
        "query B snapshot contains the kernel card",
        tree.includes("ubiquity-os/ubiquity-os-kernel"),
      );
      checkTrue(
        "query B snapshot contains the keyword score label",
        tree.includes("Keyword match score"),
      );
      await runBrowser(
        ["screenshot", SCREENSHOT_NORMAL_PATH],
        "normal-screenshot",
      );
      await checkPngArtifact("screenshot-normal", SCREENSHOT_NORMAL_PATH);
    },
  );

  await step(
    "08-reload-autoselect",
    "acceptance 5: after reload, query B auto-selects ubiquity-os/ubiquity-os-kernel",
    async () => {
      await runBrowser(["reload"], "reload");
      await runBrowser(
        [
          "wait",
          "--fn",
          "document.querySelectorAll('#suggestions li').length === 5",
        ],
        "reload-render",
      );
      const fresh = await evalJson("reload-state", CAPTURE_STATE_BODY);
      check("reload clears the proposal", fresh.proposalValue, "");
      check(
        "reload restores the catalog auto-selection",
        fresh.selectValue,
        "ubiquity/pay.ubq.fi",
      );
      await runBrowser(["fill", "#proposal", QUERY_B], "reload-query-b-fill");
      await runBrowser(
        [
          "wait",
          "--fn",
          "document.querySelector('#issue-link').href.startsWith('https://github.com/ubiquity-os/ubiquity-os-kernel/issues/new')",
        ],
        "reload-query-b-href",
      );
      const state = await evalJson("reload-query-b-state", CAPTURE_STATE_BODY);
      check(
        "reload query B auto-selected kernel",
        state.selectValue,
        "ubiquity-os/ubiquity-os-kernel",
      );
      check(
        "reload query B first suggestion",
        (state.suggestions as unknown[])[0],
        "ubiquity-os/ubiquity-os-kernel",
      );
      check(
        "reload query B has no pinned extra option",
        (state.selectOptions as unknown[]).length,
        5,
      );
      check(
        "reload query B issue href",
        state.href,
        expectedIssueUrl("ubiquity-os/ubiquity-os-kernel", QUERY_B, QUERY_B),
      );
      check("reload query B decoded title", state.decodedTitle, QUERY_B);
      check("reload query B decoded body", state.decodedBody, QUERY_B);
      check("reload query B location unchanged", state.location, BASE_URL);
    },
  );

  await step(
    "09-clipboard",
    "acceptance 6: real copy clicks with a controlled clipboard stub, resolve then reject",
    async () => {
      const expected = expectedIssueUrl(
        "ubiquity-os/ubiquity-os-kernel",
        QUERY_B,
        QUERY_B,
      );
      const installed = await evalJson(
        "clipboard-stub-install",
        CLIPBOARD_INSTALL_BODY,
      );
      check(
        "clipboard stub installed over navigator.clipboard",
        installed.installed,
        true,
      );
      check(
        "clipboard stub installed on the kernel issue URL",
        installed.href,
        expected,
      );
      check(
        "issue link is enabled before copying",
        installed.ariaDisabled,
        "false",
      );

      await runBrowser(["click", "#copy-link"], "copy-success-click");
      await runBrowser(["wait", "--text", "Copied"], "copy-success-wait");
      const success = await evalJson(
        "copy-success-state",
        CLIPBOARD_STATE_BODY,
      );
      check("copy success label", success.label, "Copied");
      check(
        "copy success recorded exactly one write",
        (success.calls as unknown[]).length,
        1,
      );
      check(
        "copy success captured the exact href",
        (success.calls as unknown[])[0],
        expected,
      );
      check(
        "copy success left the issue href unchanged",
        success.href,
        expected,
      );
      check(
        "copy success left the page on the local origin",
        success.location,
        BASE_URL,
      );

      const reject = await evalJson(
        "clipboard-stub-reject",
        '      window.__proof.mode = "reject";\n      return { mode: window.__proof.mode, priorCalls: window.__proof.calls.length };',
      );
      check("clipboard stub switched to reject", reject.mode, "reject");
      check(
        "clipboard stub kept the first captured write",
        reject.priorCalls,
        1,
      );

      await runBrowser(["click", "#copy-link"], "copy-failure-click");
      await runBrowser(["wait", "--text", "Copy failed"], "copy-failure-wait");
      const failure = await evalJson(
        "copy-failure-state",
        CLIPBOARD_STATE_BODY,
      );
      check("copy failure label", failure.label, "Copy failed");
      checkTrue(
        "copy failure never reported success",
        failure.label !== "Copied",
        failure.label,
      );
      check(
        "copy failure recorded a second write",
        (failure.calls as unknown[]).length,
        2,
      );
      check(
        "copy failure captured the exact href",
        (failure.calls as unknown[])[1],
        expected,
      );
      check(
        "copy failure left the issue href unchanged",
        failure.href,
        expected,
      );
      checkTrue(
        "copy failure exposes the clipboard-unavailable hint",
        String(failure.hint).includes("Clipboard blocked"),
        failure.hint,
      );
      check(
        "copy feedback reset was suppressed for stable evidence",
        failure.resetSuppressed,
        true,
      );

      await runBrowser(
        ["screenshot", SCREENSHOT_FAILURE_PATH],
        "copy-failure-screenshot",
      );
      await checkPngArtifact("screenshot-copy-failed", SCREENSHOT_FAILURE_PATH);
    },
  );
}

async function cleanup(): Promise<void> {
  const record = beginStep(
    "99-cleanup",
    "close only the owned session, verify no launched browser remains, and shut down the local server",
  );
  const startedAt = Date.now();
  try {
    if (sessionTouched) {
      try {
        const close = await runBrowser(
          ["close"],
          "cleanup-close",
          DEFAULT_TIMEOUT_MS,
          undefined,
          true,
        );
        check("owned session close exit code", close.result.code, 0);
        check(
          "owned session close reported success",
          close.envelope.success,
          true,
        );
      } catch (error) {
        closeError = toError(error);
        note(`owned session close failed: ${errorMessage(error)}`);
      }
      try {
        postCloseOwnedSession = await readOwnedSessionState(
          "cleanup-session-after-close",
          true,
        );
        if (postCloseOwnedSession.session !== null) {
          check(
            "post-close session info reports the owned session",
            postCloseOwnedSession.session,
            SESSION,
          );
        }
        if (postCloseOwnedSession.namespace !== null) {
          check(
            "post-close session info reports the owned namespace",
            postCloseOwnedSession.namespace,
            NAMESPACE,
          );
        }
        checkTrue(
          `owned session ${SESSION} has no launched browser after close (browserLaunched=false/pageCount=0 or absent runtime); close alone does not prove daemon termination`,
          postCloseOwnedSession.status === "absent-runtime" ||
            postCloseOwnedSession.status === "inactive-runtime" ||
            postCloseOwnedSession.status === "idle",
          postCloseOwnedSession,
        );
      } catch (error) {
        postCloseError = toError(error);
        note(`post-close session verification failed: ${errorMessage(error)}`);
      }
    } else {
      note(
        "no browser session was opened; close skipped so another owner's session is never touched",
      );
    }
    try {
      await stopStaticServer();
    } catch (error) {
      serverError = toError(error);
      note(`static server shutdown failed: ${errorMessage(error)}`);
    }
  } catch (error) {
    cleanupError = toError(error);
    record.status = "failed";
    record.error = errorMessage(error);
    note(`cleanup failed: ${errorMessage(error)}`);
    try {
      await stopStaticServer();
    } catch (shutdownError) {
      if (!serverError) serverError = toError(shutdownError);
    }
  } finally {
    const cleanupFailures = [
      cleanupError,
      closeError,
      postCloseError,
      serverError,
    ].filter(
      (error): error is Error => error !== null,
    );
    if (record.status === "running") {
      record.status = cleanupFailures.length === 0 ? "passed" : "failed";
    }
    if (!record.error && cleanupFailures.length > 0) {
      record.error = cleanupFailures.map((error) => errorMessage(error)).join(
        " | ",
      );
    }
    record.durationMs = Date.now() - startedAt;
  }
}

function collectFailures(): Error[] {
  return [
    mainError,
    cleanupError,
    closeError,
    postCloseError,
    serverError,
    receiptError,
  ].filter(
    (error): error is Error => error !== null,
  );
}

async function writeReceipt(): Promise<void> {
  const failures = collectFailures();
  await Deno.writeTextFile(
    TRANSCRIPT_PATH,
    `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const transcriptInfo = await recordArtifact("transcript", TRANSCRIPT_PATH);
  const receipt = {
    schemaVersion: 1,
    worker: WORKER_ID,
    outcome: failures.length === 0 ? "passed" : "failed",
    startedAt: new Date(STARTED_AT).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - STARTED_AT,
    host: `${Deno.build.os}/${Deno.build.arch}`,
    denoVersion: Deno.version.deno,
    worktreeRoot: ROOT_DIR,
    registeredCommand: REGISTERED_COMMAND,
    registeredCwd: ROOT_DIR,
    assignment: {
      base: "12609d2488f281e625a314fa46c62b6bf202f478",
      branch: "codex/plan-m-proposal-composer-a97d40fc55e",
      note:
        "recorded from the assignment; this driver does not run git and does not verify repository state",
    },
    staticServer: {
      started: serverStarted,
      stopped: serverStopped,
      host: HOST,
      port: PORT,
      url: BASE_URL,
      fsRoot: ROUTER_DIR,
      urlRoot: "proposal-router",
      module: "jsr:@std/http@1.0.21/file-server serveDir",
    },
    browser: {
      cli: AGENT_BROWSER,
      namespace: NAMESPACE,
      session: SESSION,
      configPath: relativePath(CONFIG_PATH),
      executablePath: CHROMIUM,
      allowedDomains: ALLOWED_DOMAINS,
      childEnvKeys: Object.keys(CHILD_ENV).sort(),
      globals: GLOBALS,
      preflightOwnedSession,
      postCloseOwnedSession,
      cleanupEvidence:
        "Lifecycle absence is judged from exact `session info` runtime metadata (browserLaunched===false and pageCount===0, or an absent/inactive runtime), not from `session list`, which returned [] on agent-browser 0.36.0 while this exact session still had a launched browser. `active` is daemon activity, not browser liveness; `close` proves no launched browser remains, not that the daemon process terminated.",
    },
    steps,
    artifacts: { ...artifacts, transcript: transcriptInfo },
    notes,
    errors: failures.map((error) => errorMessage(error)),
  };
  await Deno.writeTextFile(
    RECEIPT_PATH,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

try {
  try {
    await main();
  } catch (error) {
    mainError = toError(error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = cleanupError ?? toError(error);
    }
    try {
      await writeReceipt();
    } catch (error) {
      receiptError = toError(error);
    }
  }

  const failures = collectFailures();
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[${WORKER_ID}] failure: ${errorMessage(failure)}`);
    }
    console.error(`[${WORKER_ID}] FAILED; receipt: ${RECEIPT_PATH}`);
    throw failures[0];
  }
  console.log(
    `[${WORKER_ID}] PASSED in ${
      Date.now() - STARTED_AT
    } ms; receipt: ${RECEIPT_PATH}`,
  );
} catch (error) {
  console.error(`[${WORKER_ID}] driver error: ${errorMessage(error)}`);
  throw error;
}
