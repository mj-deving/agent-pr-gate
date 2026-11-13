import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDiff } from "./diff.ts";
import { DETECTOR_VERSION, detectFiles, sortFindings, type Finding } from "./detect.ts";
import { parseScope, scopeFindings } from "./scope.ts";

export type Mode = "warn" | "block";

export interface GateInput {
  diff: string;
  /** PR description; may be empty. */
  body: string;
  /** Contents of `.agent-scope.yml` on the base commit, or null when the file does not exist there. */
  scopeFile: string | null;
  mode: Mode;
}

/**
 * The scope rules in force. The base-branch file is the maintainer's boundary and always applies
 * when it exists. The PR body is written by the agent, so it can only narrow: a changed path must
 * match the file patterns AND, when present, the body patterns. The body alone applies only when
 * the base commit has no `.agent-scope.yml`.
 */
export interface Scope {
  file: string[] | null;
  body: string[] | null;
  /** `.agent-scope.yml` exists on the base commit but holds no `scope:` patterns. */
  fileWithoutPatterns: boolean;
}

export interface GateResult {
  findings: Finding[];
  scope: Scope;
  summary: string;
  exitCode: 0 | 1;
}

/** Pure core of the action: diff + PR text + base scope file + mode in, report and exit code out. */
export function gate(input: GateInput): GateResult {
  const files = parseDiff(input.diff);
  const file = input.scopeFile === null ? null : parseScope(input.scopeFile);
  const scope: Scope = {
    file,
    body: parseScope(input.body),
    fileWithoutPatterns: input.scopeFile !== null && file === null,
  };
  const sets = [scope.file, scope.body].filter((s): s is string[] => s !== null);
  const findings = sortFindings([...detectFiles(files), ...(sets.length > 0 ? scopeFindings(files, ...sets) : [])]);
  const blocking = findings.filter((f) => !f.allowed).length;
  const exitCode = input.mode === "block" && blocking > 0 ? 1 : 0;
  return { findings, scope, exitCode, summary: renderSummary(findings, scope, input.mode, exitCode) };
}

export function parseMode(raw: string | undefined): Mode {
  const mode = (raw ?? "").trim().toLowerCase() || "warn";
  if (mode !== "warn" && mode !== "block") throw new Error(`input "mode" must be "warn" or "block", got "${raw}"`);
  return mode;
}

// ---------------------------------------------------------------------------
// Report

const MAX_ROWS = 300; // keeps the job summary far below GitHub's 1 MiB limit

const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ");

function lineLabel(f: Finding): string {
  if (f.line === 0) return "file";
  return f.side === "old" ? `${f.line} (old)` : String(f.line);
}

export function renderSummary(
  findings: Finding[],
  scope: Scope,
  mode: Mode,
  exitCode: 0 | 1,
): string {
  const allowed = findings.filter((f) => f.allowed).length;
  const open = findings.length - allowed;
  const out: string[] = ["## agent-pr-gate", ""];
  out.push(
    `**Mode:** \`${mode}\` · **Findings:** ${findings.length} (${open} unallowed, ${allowed} allowed) · detector ${DETECTOR_VERSION}`,
    "",
  );
  const list = (patterns: string[]) => patterns.map((p) => `<code>${html(p)}</code>`).join(", ");
  if (scope.file) out.push(`**Scope** from \`.agent-scope.yml\` on the base branch: ${list(scope.file)}`, "");
  if (scope.body) {
    out.push(`**Scope** from the PR body${scope.file ? " (narrows the file scope)" : ""}: ${list(scope.body)}`, "");
  }
  if (scope.fileWithoutPatterns) {
    out.push("> **Note:** `.agent-scope.yml` on the base branch has no `scope:` patterns and was ignored.", "");
  }
  if (!scope.file && !scope.body) {
    out.push("> **Note:** no `scope:` block in the PR body or `.agent-scope.yml`; scope check skipped.", "");
  }
  if (findings.length > 0) {
    const status = (f: Finding) =>
      f.allowed ? `allowed: ${html(f.allowed)}` : mode === "block" ? "**blocking**" : "warning";
    out.push("| Class | File | Line | Code | Status |", "|---|---|---|---|---|");
    for (const f of findings.slice(0, MAX_ROWS)) {
      out.push(`| ${f.class} | <code>${html(f.file)}</code> | ${lineLabel(f)} | <code>${html(f.text)}</code> | ${status(f)} |`);
    }
    if (findings.length > MAX_ROWS) out.push("", `_${findings.length - MAX_ROWS} more findings not shown._`);
    out.push("");
  }
  out.push(
    exitCode === 1
      ? `**Result:** blocked, ${open} unallowed finding${open === 1 ? "" : "s"}. Fix them or justify each with a \`gate-allow: <reason>\` comment.`
      : open > 0
        ? `**Result:** passed in warn mode with ${open} unallowed finding${open === 1 ? "" : "s"}.`
        : "**Result:** passed.",
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub I/O

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const cmdData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const cmdProp = (s: string) => cmdData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** One workflow-command annotation per unallowed finding, so findings also show inline on the PR. */
export function annotations(findings: Finding[], mode: Mode): string[] {
  return findings
    .filter((f) => !f.allowed)
    .map((f) => {
      const props = [`file=${cmdProp(f.file)}`];
      if (f.line > 0 && f.side === "new") props.push(`line=${f.line}`);
      props.push(`title=${cmdProp(`agent-pr-gate: ${f.class}`)}`);
      return `::${mode === "block" ? "error" : "warning"} ${props.join(",")}::${cmdData(f.text)}`;
    });
}

interface PullRequestEvent {
  number: number;
  body: string;
  baseSha: string;
}

function readPullRequest(eventPath: string): PullRequestEvent {
  const payload: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = (payload as { pull_request?: unknown }).pull_request as
    | { number?: unknown; body?: unknown; base?: { sha?: unknown } }
    | undefined;
  if (!pr || typeof pr.number !== "number" || typeof pr.base?.sha !== "string") {
    throw new Error("event payload has no pull_request with number and base.sha");
  }
  return { number: pr.number, body: typeof pr.body === "string" ? pr.body : "", baseSha: pr.base.sha };
}

async function getText(fetchImpl: Fetch, url: string, token: string, accept: string): Promise<string | null> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-pr-gate",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

/** Runs the action against the environment GitHub provides. Returns the process exit code. */
export async function run(env: Env, fetchImpl: Fetch = fetch, log: (line: string) => void = console.log): Promise<0 | 1> {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "pull_request_target") {
    log(`::notice title=agent-pr-gate::skipped: event "${event ?? "unknown"}" is not a pull_request event`);
    return 0;
  }
  const mode = parseMode(env.INPUT_MODE);
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("no token: set the `token` input or GITHUB_TOKEN");
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY) throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY must be set");
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const repo = env.GITHUB_REPOSITORY;
  const pr = readPullRequest(env.GITHUB_EVENT_PATH);

  const diff = await getText(fetchImpl, `${api}/repos/${repo}/pulls/${pr.number}`, token, "application/vnd.github.v3.diff");
  if (diff === null) throw new Error(`pull request #${pr.number} not found in ${repo}`);
  // Always read from the base commit, whatever the body says: the PR under review must not be able
  // to widen its scope, neither by editing the file nor by declaring a scope of its own.
  const scopeFile = await getText(
    fetchImpl,
    `${api}/repos/${repo}/contents/.agent-scope.yml?ref=${encodeURIComponent(pr.baseSha)}`,
    token,
    "application/vnd.github.raw",
  );

  const result = gate({ diff, body: pr.body, scopeFile, mode });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary);
  else log(result.summary);
  for (const line of annotations(result.findings, mode)) log(line);
  return result.exitCode;
}

// Compare real paths: Node resolves symlinks for the main module, argv[1] keeps the path as given.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  run(process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.log(`::error title=agent-pr-gate::${cmdData(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = 1;
    },
  );
}
