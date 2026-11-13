import { displayPath, parseDiff, type DiffLine, type FileDiff, type Hunk } from "./diff.ts";
import { languageOf, lexLine, type Language, type LexedLine, type LexState } from "./lex.ts";

export const DETECTOR_VERSION = "0.2.3";

export type DefectClass =
  | "skip"
  | "only"
  | "type-suppress"
  | "lint-suppress"
  | "assert-removed"
  | "test-deleted"
  | "threshold-lowered"
  | "out-of-scope";

export interface Finding {
  file: string;
  /** 1-based line in the new ("new") or old ("old") file; 0 means the finding is about the whole file. */
  line: number;
  side: "new" | "old";
  class: DefectClass;
  /** The triggering line, trimmed; for whole-file findings a short description. */
  text: string;
  /** Present when a `gate-allow: <reason>` comment covers this finding. */
  allowed?: string;
}

export function detect(diff: string): Finding[] {
  return detectFiles(parseDiff(diff));
}

// ---------------------------------------------------------------------------
// Per-line view of a diff: each line lexed in the language of its file, on its own side.

interface Row {
  line: DiffLine;
  lexed: LexedLine;
}

interface LexedHunk {
  rows: Row[];
}

interface LexedFile {
  file: FileDiff;
  path: string;
  lang: Language;
  test: boolean;
  hunks: LexedHunk[];
}

function lexFile(file: FileDiff): LexedFile {
  const path = displayPath(file);
  const lang = languageOf(path);
  const hunks = file.hunks.map((hunk: Hunk): LexedHunk => {
    // A hunk can start inside a block comment or multi-line string; we assume it does not.
    let newState: LexState = "code";
    let oldState: LexState = "code";
    const rows = hunk.lines.map((line): Row => {
      if (line.kind === "-") {
        const lexed = lexLine(line.text, lang, oldState);
        oldState = lexed.state;
        return { line, lexed };
      }
      const lexed = lexLine(line.text, lang, newState);
      newState = lexed.state;
      if (line.kind === " ") oldState = lexLine(line.text, lang, oldState).state;
      return { line, lexed };
    });
    return { rows };
  });
  return { file, path, lang, test: isTestFile(path), hunks };
}

export function isTestFile(path: string): boolean {
  const lang = languageOf(path);
  if (lang === "other") return false;
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path)) return true;
  if (lang === "js") return /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/.test(path);
  return /(^|\/)(test_[^/]*|[^/]*_test|tests)\.py$/.test(path);
}

// ---------------------------------------------------------------------------
// gate-allow

const ALLOW = /gate-allow:(.*)$/;

/** The reason of a `gate-allow:` comment on this row, or null when absent or empty. */
function allowReason(row: Row | undefined, lang: Language): string | null {
  if (!row) return null;
  // Code files: the marker must sit in a comment. Config files (JSON, YAML, TOML) are matched raw,
  // since JSON has no comments and a `"//": "gate-allow: ..."` key is the usual workaround.
  const sources = lang === "other" ? [row.line.text] : row.lexed.comments;
  for (const text of sources) {
    const m = ALLOW.exec(text);
    if (!m) continue;
    const reason = m[1]!.replace(/(\*\/|-->)\s*$/, "").replace(/["',\s]+$/, "").trim();
    if (reason) return reason;
  }
  return null;
}

/** An added or context line is covered by an allow on itself or on the new-side line directly above. */
function allowForNew(hunk: LexedHunk, idx: number, lang: Language): string | null {
  const own = allowReason(hunk.rows[idx], lang);
  if (own) return own;
  for (let k = idx - 1; k >= 0; k--) {
    const row = hunk.rows[k]!;
    if (row.line.kind !== "-") return allowReason(row, lang);
  }
  return null;
}

/**
 * A removed line is covered by an allow on an added line next to the removal: the new-side line
 * directly above the removed run, or the first new-side line after it. Only added lines count,
 * because only the PR itself can justify a removal.
 * Known limit: one allow covers the whole contiguous removed run, not a single removed line.
 */
function allowForOld(hunk: LexedHunk, idx: number, lang: Language): string | null {
  const added = (row: Row | undefined) => (row && row.line.kind === "+" ? allowReason(row, lang) : null);
  let k = idx;
  while (k >= 0 && hunk.rows[k]!.line.kind === "-") k--;
  const above = added(hunk.rows[k]);
  if (above) return above;
  k = idx;
  while (k < hunk.rows.length && hunk.rows[k]!.line.kind === "-") k++;
  return added(hunk.rows[k]);
}

// ---------------------------------------------------------------------------
// Added-line rules: skip, only, type-suppress, lint-suppress.

interface Pattern {
  re: RegExp;
  testOnly?: boolean;
}

const TEST_FN = "(?:it|test|describe|context|suite|specify)";

const JS_SKIP: Pattern[] = [
  { re: new RegExp(`\\b${TEST_FN}(?:\\.\\w+)*\\.(?:skip|skipIf|fixme)\\b`) },
  { re: /(?<![\w$.])(?:xit|xdescribe|xtest|xcontext|xspecify)\s*\(/, testOnly: true },
  { re: /\bthis\.skip\s*\(/, testOnly: true },
];
const PY_SKIP: Pattern[] = [
  { re: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { re: /\bpytest\.(?:skip|xfail)\s*\(/ },
  { re: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/ },
  { re: /^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b/ },
  { re: /\bself\.skipTest\s*\(/ },
  { re: /\braise\s+(?:unittest\.)?SkipTest\b/ },
];
const JS_ONLY: Pattern[] = [
  { re: new RegExp(`\\b${TEST_FN}(?:\\.\\w+)*\\.only\\b`) },
  { re: /(?<![\w$.])(?:fit|fdescribe|ftest|fcontext)\s*\(/, testOnly: true },
];

const JS_TYPE_DIRECTIVE = /^@ts-(?:ignore|expect-error|nocheck)\b/;
const JS_LINT_DIRECTIVE =
  /^(?:eslint-disable|biome-ignore|oxlint-disable|tslint:disable|istanbul\s+ignore|c8\s+ignore|v8\s+ignore)\b/;
const PY_TYPE_DIRECTIVE = /^(?:type:\s*ignore|pyright:\s*ignore|mypy:\s*ignore-errors)\b/;
const PY_LINT_DIRECTIVE = /^(?:noqa|(?:ruff|flake8):\s*noqa|pylint:\s*disable|nosec|pragma:\s*no\s*cover)\b/i;

/** Classes of suppression directives that open a comment. Mentions later in the comment do not count. */
function directiveClasses(lexed: LexedLine, lang: Language): DefectClass[] {
  const found = new Set<DefectClass>();
  for (const comment of lexed.comments) {
    if (lang === "js") {
      const body = comment.replace(/^[\s*/!]+/, "");
      if (JS_TYPE_DIRECTIVE.test(body)) found.add("type-suppress");
      if (JS_LINT_DIRECTIVE.test(body)) found.add("lint-suppress");
    } else {
      // Python tools accept their directive at the start of any `#` segment: `# type: ignore  # noqa`.
      for (const segment of comment.split("#")) {
        const body = segment.trim();
        if (PY_TYPE_DIRECTIVE.test(body)) found.add("type-suppress");
        if (PY_LINT_DIRECTIVE.test(body)) found.add("lint-suppress");
      }
    }
  }
  return [...found];
}

function matches(patterns: Pattern[], code: string, test: boolean): boolean {
  return patterns.some((p) => (!p.testOnly || test) && p.re.test(code));
}

function addedLineFindings(f: LexedFile): Finding[] {
  if (f.lang === "other") return [];
  const out: Finding[] = [];
  for (const hunk of f.hunks) {
    hunk.rows.forEach((row, idx) => {
      if (row.line.kind !== "+") return;
      const classes = directiveClasses(row.lexed, f.lang);
      const code = row.lexed.masked;
      if (matches(f.lang === "js" ? JS_SKIP : PY_SKIP, code, f.test)) classes.push("skip");
      if (f.lang === "js" && matches(JS_ONLY, code, f.test)) classes.push("only");
      if (classes.length === 0) return;
      const allowed = allowForNew(hunk, idx, f.lang);
      for (const cls of classes) out.push(finding(f.path, row, cls, allowed));
    });
  }
  return out;
}

function finding(file: string, row: Row, cls: DefectClass, allowed: string | null): Finding {
  const side = row.line.kind === "-" ? "old" : "new";
  const line = (side === "old" ? row.line.oldLine : row.line.newLine) ?? 0;
  const f: Finding = { file, line, side, class: cls, text: row.line.text.trim() };
  if (allowed) f.allowed = allowed;
  return f;
}

// ---------------------------------------------------------------------------
// assert-removed

const ASSERTIONS = [
  /\b(?:expect|assert\w*)(?:\.\w+)*\s*\(/,
  /\.should\b/,
  /\bt\.(?:is|not|true|false|deepEqual|notDeepEqual|equal|notEqual|same|throws|throwsAsync|ok|notOk|match|truthy|falsy|snapshot|like)\s*\(/,
  /^\s*assert\b/,
  /\bpytest\.(?:raises|warns)\s*\(/,
];

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[;,]+$/, "");

interface Located {
  hunk: LexedHunk;
  idx: number;
  row: Row;
}

function rowsOf(f: LexedFile, kind: "+" | "-", keep: (row: Row) => boolean): Located[] {
  const out: Located[] = [];
  for (const hunk of f.hunks) {
    hunk.rows.forEach((row, idx) => {
      if (row.line.kind === kind && keep(row)) out.push({ hunk, idx, row });
    });
  }
  return out;
}

/** Index of the first row of the contiguous removed/added run that contains `loc`. */
function changeBlock(loc: Located): number {
  let k = loc.idx;
  while (k > 0 && loc.hunk.rows[k - 1]!.line.kind !== " ") k--;
  return k;
}

const isAssertion = (row: Row) => ASSERTIONS.some((re) => re.test(row.lexed.masked));

/**
 * Removed test assertions that were not put back. A removed assertion is forgiven only by
 *  (a) an identical (whitespace-normalized) added assertion anywhere in the diff: a move, or
 *  (b) an added assertion in the same change block, paired 1:1: a rewrite in place. A change
 *      block is a run of removed and added lines with no context line between them, so a new
 *      test appended further down the same hunk does not offset a deleted assertion above it.
 * Unrelated assertions added elsewhere do not offset a removal. Assertions of a deleted test
 * file are left to test-deleted.
 */
function assertRemovedFindings(files: LexedFile[]): Finding[] {
  const code = files.filter((f) => f.lang !== "other");
  const added = code.flatMap((f) => rowsOf(f, "+", isAssertion));
  const pool = new Map<string, Located[]>();
  for (const a of added) {
    const key = normalize(a.row.line.text);
    pool.set(key, [...(pool.get(key) ?? []), a]);
  }
  const claimed = new Set<Located>();
  const targets = files.filter((f) => f.test && f.file.status !== "deleted");
  const unmatched = targets.flatMap((f) =>
    rowsOf(f, "-", isAssertion)
      .filter((r) => {
        const twin = pool.get(normalize(r.row.line.text))?.shift();
        if (twin) claimed.add(twin);
        return !twin;
      })
      .map((r) => ({ f, r })),
  );

  const rewrites = new Map<LexedHunk, Map<number, number>>(); // unclaimed added assertions per change block
  for (const a of added) {
    if (claimed.has(a)) continue;
    const blocks = rewrites.get(a.hunk) ?? new Map<number, number>();
    blocks.set(changeBlock(a), (blocks.get(changeBlock(a)) ?? 0) + 1);
    rewrites.set(a.hunk, blocks);
  }
  return unmatched
    .filter(({ r }) => {
      const blocks = rewrites.get(r.hunk);
      const n = blocks?.get(changeBlock(r)) ?? 0;
      if (n > 0) blocks!.set(changeBlock(r), n - 1);
      return n === 0;
    })
    .map(({ f, r }) => finding(f.path, r.row, "assert-removed", allowForOld(r.hunk, r.idx, f.lang)));
}

// ---------------------------------------------------------------------------
// test-deleted

const JS_TEST_HEAD = /\b(?:it|test|specify)(?:\.\w+)*\s*\(\s*(["'`])/g;
const PY_TEST_DEF = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/;

/** The test name a line defines, or null. */
function testName(row: Row, lang: Language): string | null {
  const { masked } = row.lexed;
  if (lang === "py") return PY_TEST_DEF.exec(masked)?.[1] ?? null;
  if (lang !== "js") return null;
  JS_TEST_HEAD.lastIndex = 0;
  const m = JS_TEST_HEAD.exec(masked);
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = masked.indexOf(m[1]!, open);
  return row.line.text.slice(open, close < 0 ? undefined : close);
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function testDeletedFindings(files: LexedFile[]): Finding[] {
  const defs = (f: LexedFile, kind: "+" | "-") =>
    rowsOf(f, kind, (row) => testName(row, f.lang) !== null).map((loc) => ({ loc, name: testName(loc.row, f.lang)! }));
  const tests = files.filter((f) => f.test).map((f) => ({ f, added: defs(f, "+"), removed: defs(f, "-") }));

  // Phase 1: a removed test whose name is added anywhere in the diff was kept or moved.
  const pool = new Map<string, Located[]>();
  for (const { added } of tests) {
    for (const d of added) pool.set(d.name, [...(pool.get(d.name) ?? []), d.loc]);
  }
  const claimed = new Set<Located>();
  const missingOf = (removed: { loc: Located; name: string }[]) =>
    removed.filter((d) => {
      const loc = pool.get(d.name)?.shift();
      if (loc) claimed.add(loc);
      return !loc;
    });
  const matched = tests.map((t) => ({ ...t, missing: missingOf(t.removed) }));
  const addedBasenames = new Set(
    files.filter((f) => f.file.status !== "deleted" && f.file.newPath).map((f) => basename(f.path)),
  );

  // Phase 2: tests added to the same file and not claimed by name are renames of missing ones.
  const out: Finding[] = [];
  // A test file renamed out of the test naming convention stops running, like a deletion.
  for (const f of files) {
    const from = f.file.oldPath;
    if (f.file.status === "renamed" && from && isTestFile(from) && !f.test) {
      out.push({ file: f.path, line: 0, side: "new", class: "test-deleted", text: `test file renamed out of the test convention (from ${from})` });
    }
  }
  for (const { f, added, removed, missing } of matched) {
    if (f.file.status === "deleted") {
      const moved = removed.length > 0 ? missing.length === 0 : addedBasenames.has(basename(f.path));
      if (!moved) {
        const detail = removed.length > 0 ? `${missing.length} of ${removed.length} tests not re-added` : "no tests re-added";
        out.push({ file: f.path, line: 0, side: "old", class: "test-deleted", text: `deleted test file (${detail})` });
      }
      continue;
    }
    // A removed test is a title rename only if an unclaimed test was added in the same change block.
    const free = added.filter((d) => !claimed.has(d.loc)).map((d) => d.loc);
    for (const { loc } of missing) {
      const k = free.findIndex((x) => x.hunk === loc.hunk && changeBlock(x) === changeBlock(loc));
      if (k >= 0) {
        free.splice(k, 1);
        continue;
      }
      out.push(finding(f.path, loc.row, "test-deleted", allowForOld(loc.hunk, loc.idx, f.lang)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// threshold-lowered

const CONFIG_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  ".coveragerc",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
  ".flake8",
  ".pylintrc",
  "pylintrc",
  ".nycrc",
  ".nycrc.json",
  ".nycrc.yml",
  ".nycrc.yaml",
  ".c8rc",
  ".c8rc.json",
  "Makefile",
]);

export function isThresholdConfig(path: string): boolean {
  const name = basename(path);
  return (
    CONFIG_NAMES.has(name) ||
    /^(?:jest|vitest|vite|karma)\.config\.[cm]?[jt]s$/.test(name) ||
    /^(?:jest|vitest)\.config\.json$/.test(name) ||
    /^\.?eslintrc(?:\.\w+)?$/.test(name) ||
    /^eslint\.config\.[cm]?[jt]s$/.test(name) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
  );
}

/** Keys where a lower value is weaker (coverage minimums) or a higher value is weaker (lint maximums). */
const THRESHOLD =
  /(?<![\w-])(?:--)?["']?(branches|lines|functions|statements|cov-fail-under|fail[_-]under|max[_-]?warnings|max[_-]complexity|max[_-]line[_-]length)["']?\s*(?:[:=]\s*|\s+)["']?(-?\d+(?:\.\d+)?)/gi;

interface Threshold {
  key: string;
  value: number;
  loc: Located;
}

function thresholdsOn(loc: Located, path: string): Threshold[] {
  let text = loc.row.line.text;
  if (!/\.json$|^\.nycrc$|^\.c8rc$/.test(basename(path))) text = text.replace(/(^|\s)#.*$/, "").replace(/^\s*;.*$/, "");
  const out: Threshold[] = [];
  for (const m of text.matchAll(THRESHOLD)) {
    const key = m[1]!.toLowerCase().replace(/[-_]/g, "").replace(/^cov/, "");
    out.push({ key, value: Number(m[2]), loc });
  }
  return out;
}

const isMaximum = (key: string) => key.startsWith("max");

function thresholdFindings(f: LexedFile): Finding[] {
  if (!isThresholdConfig(f.path)) return [];
  const all = (kind: "+" | "-") => rowsOf(f, kind, () => true).flatMap((loc) => thresholdsOn(loc, f.path));
  const removed = all("-");
  const added = all("+");
  const used = new Set<Threshold>();
  const pair = (r: Threshold, sameHunk: boolean) =>
    added.find((a) => !used.has(a) && a.key === r.key && (!sameHunk || a.loc.hunk === r.loc.hunk));

  const out: Finding[] = [];
  const pending: Threshold[] = [];
  for (const sameHunk of [true, false]) {
    for (const r of sameHunk ? removed : pending.splice(0)) {
      const a = pair(r, sameHunk);
      if (!a) {
        if (sameHunk) pending.push(r);
        else out.push(finding(f.path, r.loc.row, "threshold-lowered", allowForOld(r.loc.hunk, r.loc.idx, f.lang)));
        continue;
      }
      used.add(a);
      const weaker = isMaximum(r.key) ? a.value > r.value : a.value < r.value;
      if (weaker) out.push(finding(f.path, a.loc.row, "threshold-lowered", allowForNew(a.loc.hunk, a.loc.idx, f.lang)));
    }
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((x) => {
    const key = `${x.file}\0${x.side}\0${x.line}\0${x.class}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) ||
      (a.class < b.class ? -1 : a.class > b.class ? 1 : 0),
  );
}

export function detectFiles(files: FileDiff[]): Finding[] {
  const lexed = files.filter((f) => !f.binary).map(lexFile);
  const findings = [
    ...lexed.flatMap(addedLineFindings),
    ...assertRemovedFindings(lexed),
    ...testDeletedFindings(lexed),
    ...lexed.flatMap(thresholdFindings),
  ];
  return sortFindings(dedupe(findings));
}
