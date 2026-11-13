// Benchmark self-check. Run: bun bench/validate.ts   (no dependencies, exits 1 on any failure)
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const DIR = import.meta.dir ?? dirname(new URL(import.meta.url).pathname);
const CLASSES = ["skip", "only", "type-suppress", "lint-suppress", "assert-removed", "test-deleted", "threshold-lowered"] as const;
const LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]);
// absolute local paths (macOS, Linux home, temp dirs, Windows user dirs) must not leak into the dataset
const LOCAL = /\/Users\/\w|\/private\/|\/home\/\w+\/|\/tmp\/claude|[A-Z]:\\Users\\/;
const errors: string[] = [];
const err = (m: string) => errors.push(m);

// ---------- unified diff parsing + hunk check ----------
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] };
type File = { path: string; head: string[]; hunks: Hunk[] };
function parseDiff(txt: string, id: string): File[] {
  const files: File[] = [];
  let cur: File | null = null, h: Hunk | null = null;
  const lines = txt.replace(/\n$/, "").split("\n");
  for (const l of lines) {
    if (l.startsWith("diff --git ")) {
      cur = { path: l.match(/ "?b\/(.*?)"?$/)?.[1] ?? "", head: [l], hunks: [] };
      files.push(cur); h = null; continue;
    }
    if (!cur) { err(`${id}: content before first 'diff --git'`); return files; }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      h = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] };
      cur.hunks.push(h); continue;
    }
    if (h) h.lines.push(l); else cur.head.push(l);
  }
  return files;
}

function checkHunks(files: File[], id: string) {
  if (!files.length) err(`${id}: diff has no files`);
  for (const f of files) {
    const hasContent = f.head.some(l => l.startsWith("--- "));
    if (hasContent && !f.hunks.length) err(`${id}: ${f.path} has ---/+++ but no hunks`);
    if (hasContent && !f.head.some(l => l.startsWith("+++ "))) err(`${id}: ${f.path} missing +++ line`);
    let cum = 0, prevOldEnd = 0;
    f.hunks.forEach((h, k) => {
      let oc = 0, nc = 0;
      for (const l of h.lines) {
        const c = l[0];
        if (c === " ") { oc++; nc++; }
        else if (c === "-") oc++;
        else if (c === "+") nc++;
        else if (c === "\\") { /* \ No newline at end of file */ }
        else err(`${id}: ${f.path} hunk ${k + 1} has a line with invalid prefix: ${JSON.stringify(l.slice(0, 40))}`);
      }
      if (oc !== h.oldCount) err(`${id}: ${f.path} hunk ${k + 1} old count ${h.oldCount} != ${oc} lines`);
      if (nc !== h.newCount) err(`${id}: ${f.path} hunk ${k + 1} new count ${h.newCount} != ${nc} lines`);
      const expNew = h.oldCount === 0 ? h.oldStart + cum + 1 : h.newCount === 0 ? h.oldStart - 1 + cum : h.oldStart + cum;
      if (h.newStart !== expNew) err(`${id}: ${f.path} hunk ${k + 1} new start ${h.newStart} != expected ${expNew} (offset from earlier hunks)`);
      const oldFirst = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
      if (oldFirst < prevOldEnd) err(`${id}: ${f.path} hunk ${k + 1} overlaps or precedes the previous hunk`);
      prevOldEnd = h.oldStart + h.oldCount;
      cum += h.newCount - h.oldCount;
    });
  }
}

// ---------- independent marker evidence (dataset QA, not the detector) ----------
const isTestPath = (f: string) => /(^|\/)(tests?|__tests__|spec|testing)\/|\.(test|spec)(-d)?\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/.test(f);
const isCfg = (f: string) => /package\.json$|jest\.config|vitest\.config|pyproject\.toml|\.coveragerc|setup\.cfg|\.nycrc/.test(f);
const EVID: Record<string, (f: File[]) => boolean> = {
  "skip": fs => addedAny(fs, /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|pytest\.mark\.(skip|skipif|xfail)\b|unittest\.skip\b/),
  "only": fs => addedAny(fs, /\.only\(|\bfit\(|\bfdescribe\(/),
  "type-suppress": fs => addedAny(fs, /@ts-(ignore|expect-error|nocheck)\b|#\s*type:\s*ignore/),
  "lint-suppress": fs => addedAny(fs, /eslint-disable|#\s*noqa\b|pylint:\s*disable|biome-ignore/),
  "assert-removed": fs => fs.some(f => isTestPath(f.path) && f.hunks.some(h => h.lines.some(l => l[0] === "-" && /\bexpect\(|\bassert\b|\bassert\w*\(|\bt\.(assert|equal|same|ok|match|strictSame|deepEqual)\b/.test(l)))),
  "test-deleted": fs => fs.some(f => (isTestPath(f.path) && f.head.some(l => l.startsWith("deleted file"))) || (isTestPath(f.path) && f.hunks.some(h => h.lines.some(l => /^-\s*(it|test)\(|^-\s*(async )?def test_/.test(l))))),
  "threshold-lowered": fs => thresholdMoves(fs).lowered,
};
function addedAny(fs: File[], re: RegExp) { return fs.some(f => f.hunks.some(h => h.lines.some(l => l[0] === "+" && re.test(l.slice(1))))); }
function thresholdMoves(fs: File[]) {
  let lowered = false, raised = false;
  const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const skel = (s: string) => s.replace(/\d+(?:\.\d+)?/g, "#").trim();
  for (const f of fs) {
    if (!isCfg(f.path)) continue;
    for (const h of f.hunks) {
      const del = h.lines.filter(l => l[0] === "-").map(l => l.slice(1)), add = h.lines.filter(l => l[0] === "+").map(l => l.slice(1));
      for (const d of del) {
        const a = add.find(x => skel(x) === skel(d) && x !== d);
        if (!a || !/fail[_-]under|threshold|coverage|lines|branches|functions|statements/i.test(d)) continue;
        const nd = nums(d), na = nums(a);
        if (na.some((v, i) => v < nd[i])) lowered = true;
        if (na.some((v, i) => v > nd[i])) raised = true;
      }
    }
  }
  return { lowered, raised };
}

function netRemoved(fs: File[]) {
  const A = /\bexpect\(|\bassert\b|\bassert\w*\(|\bt\.(assert|equal|same|ok|match|strictSame|deepEqual)\b/, TH = /^[+-]\s*(it|test)\(|^[+-]\s*(async )?def test_/;
  let a = 0, t = 0;
  for (const f of fs) {
    const tf = isTestPath(f.path);
    for (const h of f.hunks) for (const l of h.lines) {
      const d = l[0] === "-" ? 1 : l[0] === "+" ? -1 : 0;
      if (!d) continue;
      if (tf && A.test(l)) a += d;
      if (TH.test(l)) t += d;
    }
  }
  return { assertions: a, tests: t };
}

// ---------- manifest ----------
const rows: any[] = [];
const mpath = join(DIR, "manifest.jsonl");
if (!existsSync(mpath)) { console.error("FAIL: manifest.jsonl missing"); process.exit(1); }
readFileSync(mpath, "utf8").split("\n").forEach((line, i) => {
  if (!line.trim()) return;
  try { rows.push(JSON.parse(line)); } catch { err(`manifest line ${i + 1}: invalid JSON`); }
});

const ids = new Set<string>();
for (const r of rows) {
  const id = String(r.id);
  if (!/^[a-z]+-\d{2,}$/.test(id)) err(`${id}: id must look like name-NN`);
  if (ids.has(id)) err(`${id}: duplicate id`); ids.add(id);
  if (!["dev", "heldout"].includes(r.set)) err(`${id}: set must be dev|heldout`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(r.repo ?? "")) err(`${id}: repo must be owner/name`);
  if (!/^[0-9a-f]{40}$/.test(r.commit ?? "")) err(`${id}: commit must be a 40-char sha`);
  if (!LICENSES.has(r.license)) err(`${id}: license '${r.license}' is not permissive (${[...LICENSES].join("/")})`);
  if (!["ts", "js", "py"].includes(r.lang)) err(`${id}: lang must be ts|js|py`);
  if (typeof r.planted !== "boolean") err(`${id}: planted must be boolean`);
  if (typeof r.note !== "string" || r.note.length < 10) err(`${id}: note missing`);
  if (!Array.isArray(r.expected)) { err(`${id}: expected must be an array`); continue; }
  if (r.planted && r.expected.length === 0) err(`${id}: planted case needs a non-empty expected`);
  if (!r.planted && r.expected.length !== 0) err(`${id}: clean case must have empty expected`);
  for (const e of r.expected) {
    if (!CLASSES.includes(e.class)) err(`${id}: unknown class '${e.class}'`);
    if (typeof e.file !== "string" || !e.file) err(`${id}: expected entry needs a file`);
  }
  if (r.also_acceptable && !(Array.isArray(r.also_acceptable) && r.also_acceptable.every((c: string) => CLASSES.includes(c as any)))) err(`${id}: bad also_acceptable`);

  const dpath = join(DIR, "diffs", `${id}.diff`);
  if (!existsSync(dpath)) { err(`${id}: diffs/${id}.diff missing`); continue; }
  const txt = readFileSync(dpath, "utf8");
  if (!txt.endsWith("\n")) err(`${id}: diff must end with a newline`);
  if (LOCAL.test(txt)) err(`${id}: diff contains an absolute local path`);
  const files = parseDiff(txt, id);
  checkHunks(files, id);
  const paths = new Set(files.map(f => f.path));
  for (const e of r.expected) if (!paths.has(e.file)) err(`${id}: expected file ${e.file} is not in the diff`);
  // marker evidence
  if (r.planted) {
    for (const e of r.expected) if (!EVID[e.class]?.(files)) err(`${id}: no ${e.class} evidence found in the diff`);
  } else {
    // unambiguous markers must be absent; assertion/test removals must be offset by additions (rewritten, moved, renamed)
    for (const c of CLASSES) if (!["assert-removed", "test-deleted"].includes(c) && EVID[c](files)) err(`${id}: clean case shows ${c} evidence`);
    const n = netRemoved(files);
    if (n.assertions > 0) err(`${id}: clean case loses ${n.assertions} net assertion line(s)`);
    if (n.tests > 0) err(`${id}: clean case loses ${n.tests} net test case(s)`);
  }
}

// orphan diff files
for (const f of readdirSync(join(DIR, "diffs"))) if (f.endsWith(".diff") && !ids.has(f.replace(/\.diff$/, ""))) err(`orphan diff without manifest row: ${f}`);

// ---------- counts ----------
const cnt = (p: (r: any) => boolean) => rows.filter(p).length;
const total = rows.length, clean = cnt(r => !r.planted), repos = new Set(rows.map(r => r.repo)).size;
const held = cnt(r => r.set === "heldout");
const byClass: Record<string, { dev: number; heldout: number }> = {};
for (const c of CLASSES) byClass[c] = { dev: cnt(r => r.planted && r.set === "dev" && r.expected.some((e: any) => e.class === c)), heldout: cnt(r => r.planted && r.set === "heldout" && r.expected.some((e: any) => e.class === c)) };
if (total < 60) err(`need >= 60 cases, have ${total}`);
if (repos < 8) err(`need >= 8 repos, have ${repos}`);
if (clean < 20) err(`need >= 20 clean cases, have ${clean}`);
if (held / total < 0.2) err(`heldout share ${(100 * held / total).toFixed(1)}% < 20%`);
if (!cnt(r => !r.planted && r.set === "heldout")) err("no clean case in heldout");
for (const c of CLASSES) {
  if (byClass[c].dev + byClass[c].heldout < 5) err(`class ${c} has < 5 planted cases`);
  if (!byClass[c].heldout) err(`class ${c} missing from heldout`);
}
const langs = new Set(rows.map(r => r.lang));
if (!langs.has("py") || !(langs.has("ts") || langs.has("js"))) err("need both TS/JS and Python cases");

// README sanity
const rd = join(DIR, "README.md");
if (!existsSync(rd)) err("README.md missing");
else if (LOCAL.test(readFileSync(rd, "utf8"))) err("README.md contains an absolute local path");

// ---------- report ----------
console.log(`cases: ${total} (clean ${clean}, planted ${total - clean}); repos: ${repos}; heldout: ${held} (${(100 * held / total).toFixed(1)}%)`);
console.log(`languages: ${[...langs].sort().join(", ")}; per-language: ${["ts", "js", "py"].map(l => `${l}=${cnt(r => r.lang === l)}`).join(" ")}`);
console.log("class".padEnd(20) + "dev".padStart(5) + "heldout".padStart(9));
for (const c of CLASSES) console.log(c.padEnd(20) + String(byClass[c].dev).padStart(5) + String(byClass[c].heldout).padStart(9));
console.log("clean".padEnd(20) + String(cnt(r => !r.planted && r.set === "dev")).padStart(5) + String(cnt(r => !r.planted && r.set === "heldout")).padStart(9));
if (errors.length) { console.error(`\nFAIL: ${errors.length} problem(s)`); for (const e of errors.slice(0, 60)) console.error(" - " + e); process.exit(1); }
console.log("\nPASS: schema, counts, hunk headers, file presence, marker evidence, no absolute local paths");
