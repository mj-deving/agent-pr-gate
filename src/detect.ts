import { displayPath, parseDiff, type DiffLine, type FileDiff, type Hunk } from "./diff.ts";
import { languageOf, lexLine, type Language, type LexedLine, type LexState } from "./lex.ts";

export const DETECTOR_VERSION = "0.4.0";

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
  context: string;
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
    return { rows, context: hunk.context };
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
// Test accounting: test-deleted and assert-removed
//
// A test file's diff is read as a ledger of test cases and assertions, so a refactor that keeps or grows
// what is tested balances out and a quiet deletion does not.
// 1. Every test definition on a side of the diff (`def test_*`; `it(`, `test(`, `specify(`, `.each` included)
//    is a head worth its parameter rows: `@pytest.mark.parametrize` lists (stacked ones multiply), the
//    `params=[...]` of fixtures it takes, `it.each`/`test.each` tables; 1 when none or not countable.
// 2. A removed head is kept when its name is added anywhere in the diff, renamed when an added head sits in
//    its change block, folded when a parameterised head of the same file has rows to spare (rows beyond the
//    one it stands for, or rows newly added to a surviving test); any other removed head is test-deleted.
// 3. Each assertion belongs to the innermost test head above it in its hunk (by indentation), else to the
//    test the hunk header names. A removed assertion is offset by an identical added assertion anywhere,
//    else by added assertions of the same test (a kept or renamed test is the same test), each side
//    weighted by that test's rows. Assertions of new tests never offset removals in other tests, and the
//    assertions of a deleted or folded test are judged with the test, not one by one.
// 4. An assertion that no test head owns falls back to 1:1 pairing within its change block.

const ASSERTIONS = [
  /\b(?:expect|assert\w*)(?:\.\w+)*\s*\(/,
  /\.should\b/,
  /\bt\.(?:is|not|true|false|deepEqual|notDeepEqual|equal|notEqual|same|throws|throwsAsync|ok|notOk|match|truthy|falsy|snapshot|like)\s*\(/,
  /^\s*assert\b/,
  /\bpytest\.(?:raises|warns)\s*\(/,
];

const isAssertion = (row: Row) => ASSERTIONS.some((re) => re.test(row.lexed.masked));
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
function changeBlock(loc: { hunk: LexedHunk; idx: number }): number {
  let k = loc.idx;
  while (k > 0 && loc.hunk.rows[k - 1]!.line.kind !== " ") k--;
  return k;
}

// --- bracket helpers over masked code (string contents are blanked, so commas in strings do not count)

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return i;
  }
  return -1;
}

/** Top-level comma-separated items strictly between the brackets at `open` and `close`, trimmed, empties dropped. */
function items(s: string, open: number, close: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start, close));
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Element count of a list or tuple literal; 1 for anything else (a name, a call, a comprehension). */
function literalCount(expr: string): number {
  const t = expr.trim();
  if (!/^[[(]/.test(t) || closing(t, 0) !== t.length - 1) return 1;
  const parts = items(t, 0, t.length - 1);
  if (parts.some((p) => /\bfor\b/.test(p))) return 1;
  return Math.max(1, parts.length);
}

// --- one side of a hunk as text, so multi-line decorators, tables and titles can be read across rows

type Side = "old" | "new";

interface SideText {
  /** Hunk row index of each side row. */
  idxs: number[];
  starts: number[];
  masked: string;
  raw: string;
}

function sideText(hunk: LexedHunk, side: Side): SideText {
  const t: SideText = { idxs: [], starts: [], masked: "", raw: "" };
  const skip = side === "old" ? "+" : "-";
  hunk.rows.forEach((row, idx) => {
    if (row.line.kind === skip) return;
    t.idxs.push(idx);
    t.starts.push(t.masked.length);
    t.masked += `${row.lexed.masked}\n`;
    t.raw += `${row.line.text}\n`;
  });
  return t;
}

/** Side row (index into `idxs`) that contains `offset`. */
function sideRowAt(t: SideText, offset: number): number {
  let lo = 0;
  let hi = t.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const indentOf = (text: string) => text.length - text.trimStart().length;

// --- test heads

interface Head {
  file: LexedFile;
  hunk: LexedHunk;
  idx: number;
  row: Row;
  /** Test title or function name; "" when the diff does not show it. */
  name: string;
  /** Parameter rows: how many cases this one definition runs. */
  rows: number;
  indent: number;
  /** Side row where the definition line(s) end (title, table or argument list), so continuation lines do not close it. */
  through: number;
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;

interface PyDef {
  at: number;
  through: number;
  name: string;
  decorators: string[];
  args: string[];
}

/** Python function definitions on one side of a hunk, with the decorators directly above them. */
function pyDefs(t: SideText): PyDef[] {
  const out: PyDef[] = [];
  let pending: { indent: number; text: string }[] = [];
  let resumeAt = 0;
  for (let k = 0; k < t.idxs.length; k++) {
    const start = t.starts[k]!;
    if (start < resumeAt) continue; // inside a multi-line decorator already read
    const line = t.masked.slice(start, (t.starts[k + 1] ?? t.masked.length + 1) - 1);
    const code = line.trim();
    if (!code) continue;
    const indent = indentOf(line);
    if (code.startsWith("@")) {
      const call = /^@[\w.]+\s*\(/.exec(code);
      const at = start + indent;
      const close = call ? closing(t.masked, at + call[0].length - 1) : -1;
      const end = close >= 0 ? close + 1 : start + line.length;
      pending.push({ indent, text: t.masked.slice(at, end) });
      resumeAt = end;
      continue;
    }
    const m = PY_DEF.exec(line);
    if (m) {
      const open = start + m[0].length - 1;
      const close = closing(t.masked, open);
      const args = close < 0 ? [] : items(t.masked, open, close).map((a) => /^\**(\w+)/.exec(a)?.[1] ?? "");
      out.push({ at: k, through: close < 0 ? k : sideRowAt(t, close), name: m[2]!, decorators: pending.filter((d) => d.indent === indent).map((d) => d.text), args });
    }
    pending = [];
  }
  return out;
}

function parametrizeRows(decorator: string): number {
  const m = /\bparametrize\s*\(/.exec(decorator);
  if (!m) return 1;
  const open = m.index + m[0].length - 1;
  const close = closing(decorator, open);
  if (close < 0) return 1;
  const args = items(decorator, open, close);
  const keyword = args.find((a) => /^argvalues\s*=/.test(a));
  const values = keyword ? keyword.replace(/^argvalues\s*=/, "") : args.filter((a) => !/^\w+\s*=/.test(a))[1];
  return values ? literalCount(values) : 1;
}

/** `params=[...]` count of a `@pytest.fixture(...)` decorator, or null when it has none. */
function fixtureParams(decorator: string): number | null {
  if (!/\bfixture\b/.test(decorator)) return null;
  const m = /\bparams\s*=\s*/.exec(decorator);
  if (!m) return null;
  const rest = decorator.slice(m.index + m[0].length);
  const close = /^[[(]/.test(rest) ? closing(rest, 0) : -1;
  return close < 0 ? 1 : literalCount(rest.slice(0, close + 1));
}

const JS_HEAD = /(?<![\w$.])(?<!\bfunction\s+)(?:it|test|specify)((?:\.\w+)*)\s*([(`])/g;
const JS_MODIFIER = /^(?:only|skip|todo|fails|failing|concurrent|sequential|each|skipIf|runIf|fixme)$/;

/** JS test heads on one side of a hunk: offset of the call, title and table rows. */
function jsHeads(t: SideText): { at: number; through: number; name: string; rows: number }[] {
  const out: { at: number; through: number; name: string; rows: number }[] = [];
  for (const m of t.masked.matchAll(JS_HEAD)) {
    const chain = m[1]!.split(".").filter(Boolean);
    if (!chain.every((c) => JS_MODIFIER.test(c))) continue; // test.describe(, test.beforeEach(, ...
    const at = sideRowAt(t, m.index);
    let pos = m.index + m[0].length - 1; // the "(" or "`" that opens the call
    let rows = 1;
    // `.each(table)`, `.each\`table\``, `.skipIf(cond)`: the title is in a second call after the first.
    if (m[2] === "`" || chain.some((c) => c === "each" || c === "skipIf" || c === "runIf")) {
      const close = m[2] === "`" ? t.masked.indexOf("`", pos + 1) : closing(t.masked, pos);
      if (close < 0) {
        out.push({ at, through: sideRowAt(t, pos), name: "", rows });
        continue;
      }
      if (chain.includes("each")) {
        rows =
          m[2] === "`"
            ? Math.max(1, t.raw.slice(pos + 1, close).split("\n").filter((l) => l.trim()).length - 1)
            : literalCount(t.masked.slice(pos + 1, close));
      }
      pos = close + 1;
      while (/\s/.test(t.masked[pos] ?? "")) pos++;
      if (t.masked[pos] !== "(") {
        out.push({ at, through: sideRowAt(t, pos), name: "", rows });
        continue;
      }
    }
    let q = pos + 1;
    while (/\s/.test(t.masked[q] ?? "")) q++;
    const quote = t.masked[q];
    const end = quote === "'" || quote === '"' || quote === "`" ? t.masked.indexOf(quote, q + 1) : -1;
    out.push({ at, through: sideRowAt(t, Math.min(q, t.masked.length - 1)), name: end < 0 ? "" : t.raw.slice(q + 1, end), rows });
  }
  return out;
}

/** The test a hunk header names (git's enclosing-function guess), or "". */
function headerTest(context: string, lang: Language): string {
  if (lang === "py") return /^(?:async\s+)?def\s+(test\w*)/.exec(context)?.[1] ?? "";
  return /^(?:it|test|specify)(?:\.\w+)*\s*\(\s*(["'`])(.*?)\1/.exec(context)?.[2] ?? "";
}

/** No head owns the row: `header` names the test git puts in the hunk header, null when unknown. */
type Owner = Head | { header: string } | null;

interface TestLedger {
  heads: Map<LexedFile, Record<Side, Head[]>>;
  owners: Record<Side, Map<Row, Owner>>;
}

function buildLedger(files: LexedFile[]): TestLedger {
  const tests = files.filter((f) => f.test && f.lang !== "other");
  const sides: Side[] = ["old", "new"];
  const texts = new Map<LexedHunk, Record<Side, SideText>>();
  for (const f of tests) {
    for (const h of f.hunks) texts.set(h, { old: sideText(h, "old"), new: sideText(h, "new") });
  }

  // Fixtures with `params=` multiply every test that takes them, in any file of the diff (conftest.py).
  const fixtures: Record<Side, Map<string, number>> = { old: new Map(), new: new Map() };
  const defs = new Map<SideText, PyDef[]>();
  for (const f of tests.filter((x) => x.lang === "py")) {
    for (const h of f.hunks) {
      for (const side of sides) {
        const t = texts.get(h)![side];
        const found = pyDefs(t);
        defs.set(t, found);
        for (const d of found) {
          const n = d.decorators.map(fixtureParams).find((x) => x !== null);
          if (n != null) fixtures[side].set(d.name, n);
        }
      }
    }
  }

  const ledger: TestLedger = { heads: new Map(), owners: { old: new Map(), new: new Map() } };
  for (const f of tests) {
    const heads: Record<Side, Head[]> = { old: [], new: [] };
    for (const hunk of f.hunks) {
      for (const side of sides) {
        const t = texts.get(hunk)![side];
        const found =
          f.lang === "py"
            ? defs
                .get(t)!
                .filter((d) => d.name.startsWith("test"))
                .map((d) => ({
                  at: d.at,
                  through: d.through,
                  name: d.name,
                  rows:
                    d.decorators.reduce((n, dec) => n * parametrizeRows(dec), 1) *
                    d.args.reduce((n, a) => n * (fixtures[side].get(a) ?? 1), 1),
                }))
            : jsHeads(t);
        const byRow = new Map<number, Head>();
        for (const x of found) {
          if (byRow.has(x.at)) continue; // one head per line
          const idx = t.idxs[x.at]!;
          const row = hunk.rows[idx]!;
          const head: Head = { file: f, hunk, idx, row, name: x.name, rows: x.rows, indent: indentOf(row.line.text), through: x.through };
          byRow.set(x.at, head);
          heads[side].push(head);
        }
        // Owners: the innermost head whose indentation encloses the row.
        const header = headerTest(hunk.context, f.lang);
        const stack: Head[] = [];
        let seenHead = false;
        t.idxs.forEach((idx, k) => {
          const row = hunk.rows[idx]!;
          if (row.lexed.masked.trim()) {
            const indent = indentOf(row.line.text);
            while (stack.length && stack[stack.length - 1]!.indent >= indent && stack[stack.length - 1]!.through < k) stack.pop();
            const own = byRow.get(k);
            if (own) {
              stack.push(own);
              seenHead = true;
            }
          }
          const owner: Owner = stack[stack.length - 1] ?? (!seenHead && header ? { header } : null);
          ledger.owners[side].set(row, owner);
        });
      }
    }
    ledger.heads.set(f, heads);
  }
  return ledger;
}

const isRemoved = (h: Head) => h.row.line.kind === "-";
const isAdded = (h: Head) => h.row.line.kind === "+";
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface Verdicts {
  /** A removed head kept by name or renamed in place, and the added head that stands for it now. */
  partner: Map<Head, Head>;
  findings: Finding[];
}

function judgeTests(files: LexedFile[], ledger: TestLedger): Verdicts {
  const partner = new Map<Head, Head>();
  const findings: Finding[] = [];

  // Spare rows of each new-side head: added heads bring all their rows, a surviving head the rows it gained.
  const spare = new Map<Head, number>();
  for (const { old, new: now } of ledger.heads.values()) {
    const before = new Map(old.map((h) => [h.row, h.rows]));
    for (const h of now) spare.set(h, isAdded(h) ? h.rows : Math.max(0, h.rows - (before.get(h.row) ?? h.rows)));
  }

  // Kept or moved: the name is added anywhere in the diff.
  const byName = new Map<string, Head[]>();
  for (const { new: now } of ledger.heads.values()) {
    for (const h of now.filter((x) => isAdded(x) && x.name)) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
  }
  const missingIn = new Map<LexedFile, Head[]>();
  for (const [f, { old }] of ledger.heads) {
    const missing: Head[] = [];
    for (const r of old.filter(isRemoved)) {
      const twin = r.name ? byName.get(r.name)?.shift() : undefined;
      if (twin) {
        partner.set(r, twin);
        spare.set(twin, spare.get(twin)! - 1);
      } else missing.push(r);
    }
    missingIn.set(f, missing);
  }

  for (const f of files) {
    const from = f.file.oldPath;
    // A test file renamed out of the test naming convention stops running, like a deletion.
    if (f.file.status === "renamed" && from && isTestFile(from) && !f.test) {
      findings.push({ file: f.path, line: 0, side: "new", class: "test-deleted", text: `test file renamed out of the test convention (from ${from})` });
    }
  }
  const addedBasenames = new Set(files.filter((f) => f.file.status !== "deleted" && f.file.newPath).map((f) => basename(f.path)));

  for (const [f, { old, new: now }] of ledger.heads) {
    const missing = missingIn.get(f)!;
    if (f.file.status === "deleted") {
      const removed = old.filter(isRemoved).length;
      const moved = removed > 0 ? missing.length === 0 : addedBasenames.has(basename(f.path));
      if (!moved) {
        const detail = removed > 0 ? `${missing.length} of ${removed} tests not re-added` : "no tests re-added";
        findings.push({ file: f.path, line: 0, side: "old", class: "test-deleted", text: `deleted test file (${detail})` });
      }
      continue;
    }
    const take = (h: Head | undefined) => {
      if (h) spare.set(h, spare.get(h)! - 1);
      return h;
    };
    const unexplained = missing.filter((r) => {
      // Renamed: an added head in the same change block.
      const renamed = take(now.find((a) => isAdded(a) && spare.get(a)! > 0 && a.hunk === r.hunk && changeBlock(a) === changeBlock(r)));
      if (renamed) partner.set(r, renamed);
      return !renamed;
    });
    for (const r of unexplained) {
      // Folded: a parameterised head of this file has rows to spare.
      if (take(now.find((a) => a.rows > 1 && spare.get(a)! > 0))) continue;
      findings.push(finding(f.path, r.row, "test-deleted", allowForOld(r.hunk, r.idx, f.lang)));
    }
  }
  return { partner, findings };
}

function judgeAssertions(files: LexedFile[], ledger: TestLedger, partner: Map<Head, Head>): Finding[] {
  const keyOf = (h: Head) => `${h.file.path}\0${h.name || `#${h.file.hunks.indexOf(h.hunk)}:${h.idx}`}`;
  type Account = { key: string; weight: number } | "judged-with-test" | null;
  const account = (path: string, owner: Owner | undefined): Account => {
    if (!owner) return null;
    if ("header" in owner) return { key: `${path}\0${owner.header}`, weight: 1 };
    if (!isRemoved(owner)) return { key: keyOf(owner), weight: owner.rows };
    const now = partner.get(owner);
    return now ? { key: keyOf(now), weight: owner.rows } : "judged-with-test";
  };

  const code = files.filter((f) => f.lang !== "other");
  const added = code.flatMap((f) => rowsOf(f, "+", isAssertion).map((loc) => ({ f, loc })));
  const pool = new Map<string, Located[]>();
  for (const { loc } of added) {
    const key = normalize(loc.row.line.text);
    pool.set(key, [...(pool.get(key) ?? []), loc]);
  }
  // Moved: an identical assertion is added anywhere.
  const claimed = new Set<Located>();
  const targets = files.filter((f) => f.test && f.file.status !== "deleted");
  const unmatched = targets.flatMap((f) =>
    rowsOf(f, "-", isAssertion)
      .filter((loc) => {
        const twin = pool.get(normalize(loc.row.line.text))?.shift();
        if (twin) claimed.add(twin);
        return !twin;
      })
      .map((loc) => ({ f, loc })),
  );

  const budget = new Map<string, number>(); // weighted added assertions per test
  const blocks = new Map<LexedHunk, Map<number, number>>(); // added assertions with no owning test, per change block
  for (const { f, loc } of added) {
    if (claimed.has(loc)) continue;
    const acc = account(f.path, ledger.owners.new.get(loc.row));
    if (acc && acc !== "judged-with-test") {
      budget.set(acc.key, (budget.get(acc.key) ?? 0) + acc.weight);
      continue;
    }
    const perBlock = blocks.get(loc.hunk) ?? new Map<number, number>();
    perBlock.set(changeBlock(loc), (perBlock.get(changeBlock(loc)) ?? 0) + 1);
    blocks.set(loc.hunk, perBlock);
  }

  const out: Finding[] = [];
  for (const { f, loc } of unmatched) {
    const acc = account(f.path, ledger.owners.old.get(loc.row));
    if (acc === "judged-with-test") continue;
    let offset: boolean;
    if (acc) {
      const left = budget.get(acc.key) ?? 0;
      offset = left >= acc.weight;
      if (offset) budget.set(acc.key, left - acc.weight);
    } else {
      const perBlock = blocks.get(loc.hunk);
      const n = perBlock?.get(changeBlock(loc)) ?? 0;
      offset = n > 0;
      if (offset) perBlock!.set(changeBlock(loc), n - 1);
    }
    if (!offset) out.push(finding(f.path, loc.row, "assert-removed", allowForOld(loc.hunk, loc.idx, f.lang)));
  }
  return out;
}

function testAccountingFindings(files: LexedFile[]): Finding[] {
  const ledger = buildLedger(files);
  const { partner, findings } = judgeTests(files, ledger);
  return [...judgeAssertions(files, ledger, partner), ...findings];
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
    ...testAccountingFindings(lexed),
    ...lexed.flatMap(thresholdFindings),
  ];
  return sortFindings(dedupe(findings));
}
