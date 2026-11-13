// src/action.ts
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/diff.ts
function displayPath(file) {
  return file.newPath ?? file.oldPath ?? "";
}
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseDiff(diff) {
  const files = [];
  const lines = diff.replace(/\r\n/g, `
`).split(`
`);
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0];
      if (kind === "+") {
        hunk.lines.push({ kind: "+", text: line.slice(1), newLine: newNo++ });
        newLeft--;
        continue;
      }
      if (kind === "-") {
        hunk.lines.push({ kind: "-", text: line.slice(1), oldLine: oldNo++ });
        oldLeft--;
        continue;
      }
      if (kind === " " || line === "") {
        hunk.lines.push({ kind: " ", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (kind === "\\")
        continue;
      hunk = null;
    }
    if (line.startsWith("\\"))
      continue;
    if (line.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, status: "modified", binary: false, hunks: [] };
      const [a, b] = splitGitHeader(line.slice("diff --git ".length));
      file.oldPath = a;
      file.newPath = b;
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file)
      continue;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newNo = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("new file mode"))
      file.status = "added";
    else if (line.startsWith("deleted file mode"))
      file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("--- "))
      file.oldPath = stripPrefix(line.slice(4), "a/");
    else if (line.startsWith("+++ "))
      file.newPath = stripPrefix(line.slice(4), "b/");
    else if (line.startsWith("Binary files ") || line === "GIT binary patch")
      file.binary = true;
  }
  for (const f of files) {
    if (f.status === "added")
      f.oldPath = null;
    if (f.status === "deleted")
      f.newPath = null;
    if (f.oldPath === null && f.status === "modified")
      f.status = "added";
    if (f.newPath === null && f.status === "modified")
      f.status = "deleted";
  }
  return files;
}
function stripPrefix(raw, prefix) {
  const path = unquote(raw.replace(/\t.*$/, ""));
  if (path === "/dev/null")
    return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
function splitGitHeader(rest) {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const a = unquote(rest.slice(0, end + 1));
    const b = unquote(rest.slice(end + 2));
    return [strip(a, "a/"), strip(b, "b/")];
  }
  const quoted = rest.indexOf(' "b/');
  if (quoted >= 0)
    return [strip(rest.slice(0, quoted), "a/"), strip(unquote(rest.slice(quoted + 1)), "b/")];
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " " && rest.slice(2, mid) === rest.slice(mid + 3)) {
    return [rest.slice(2, mid), rest.slice(mid + 3)];
  }
  const sep = rest.indexOf(" b/");
  if (sep < 0)
    return [null, null];
  return [strip(rest.slice(0, sep), "a/"), strip(rest.slice(sep + 1), "b/")];
}
function strip(path, prefix) {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
function closingQuote(s) {
  for (let i = 1;i < s.length; i++) {
    if (s[i] === "\\")
      i++;
    else if (s[i] === '"')
      return i;
  }
  return s.length - 1;
}
var ESCAPES = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
function unquote(raw) {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')))
    return raw;
  const bytes = [];
  const body = raw.slice(1, -1);
  for (let i = 0;i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// src/lex.ts
function languageOf(path) {
  if (/\.[cm]?[jt]sx?$/.test(path))
    return "js";
  if (/\.pyi?$/.test(path))
    return "py";
  return "other";
}
function lexLine(line, lang, state = "code") {
  if (lang === "js")
    return lexJs(line, state);
  if (lang === "py")
    return lexPy(line, state);
  return { masked: line, comments: [], state: "code" };
}
function lexJs(line, start) {
  const out = line.split("");
  const comments = [];
  let state = start;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from;k < to; k++)
      out[k] = " ";
  };
  while (i < line.length) {
    if (state === "block-comment") {
      const end = line.indexOf("*/", i);
      const stop = end < 0 ? line.length : end;
      comments.push(line.slice(i, stop));
      blank(i, end < 0 ? line.length : end + 2);
      if (end < 0)
        return { masked: out.join(""), comments, state };
      i = end + 2;
      state = "code";
      continue;
    }
    if (state === "template") {
      const end = findClose(line, i, "`");
      blank(i, end < 0 ? line.length : end);
      if (end < 0)
        return { masked: out.join(""), comments, state };
      i = end + 1;
      state = "code";
      continue;
    }
    const ch = line[i];
    const two = line.slice(i, i + 2);
    if (two === "//") {
      comments.push(line.slice(i + 2));
      blank(i, line.length);
      break;
    }
    if (two === "/*") {
      blank(i, i + 2);
      i += 2;
      state = "block-comment";
      continue;
    }
    if (ch === "`") {
      i += 1;
      state = "template";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findClose(line, i + 1, ch);
      blank(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end + 1;
      continue;
    }
    i++;
  }
  return { masked: out.join(""), comments, state };
}
function lexPy(line, start) {
  const out = line.split("");
  const comments = [];
  let state = start;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from;k < to; k++)
      out[k] = " ";
  };
  while (i < line.length) {
    if (state === "triple-single" || state === "triple-double") {
      const delim = state === "triple-single" ? "'''" : '"""';
      const end = findClose(line, i, delim);
      blank(i, end < 0 ? line.length : end);
      if (end < 0)
        return { masked: out.join(""), comments, state };
      i = end + 3;
      state = "code";
      continue;
    }
    const ch = line[i];
    if (ch === "#") {
      comments.push(line.slice(i + 1));
      blank(i, line.length);
      break;
    }
    const three = line.slice(i, i + 3);
    if (three === "'''" || three === '"""') {
      i += 3;
      state = three === "'''" ? "triple-single" : "triple-double";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findClose(line, i + 1, ch);
      blank(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end + 1;
      continue;
    }
    i++;
  }
  return { masked: out.join(""), comments, state };
}
function findClose(line, from, delim) {
  for (let i = from;i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(delim, i))
      return i;
  }
  return -1;
}

// src/detect.ts
var DETECTOR_VERSION = "0.2.3";
function lexFile(file) {
  const path = displayPath(file);
  const lang = languageOf(path);
  const hunks = file.hunks.map((hunk) => {
    let newState = "code";
    let oldState = "code";
    const rows = hunk.lines.map((line) => {
      if (line.kind === "-") {
        const lexed = lexLine(line.text, lang, oldState);
        oldState = lexed.state;
        return { line, lexed };
      }
      const lexed = lexLine(line.text, lang, newState);
      newState = lexed.state;
      if (line.kind === " ")
        oldState = lexLine(line.text, lang, oldState).state;
      return { line, lexed };
    });
    return { rows };
  });
  return { file, path, lang, test: isTestFile(path), hunks };
}
function isTestFile(path) {
  const lang = languageOf(path);
  if (lang === "other")
    return false;
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path))
    return true;
  if (lang === "js")
    return /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/.test(path);
  return /(^|\/)(test_[^/]*|[^/]*_test|tests)\.py$/.test(path);
}
var ALLOW = /gate-allow:(.*)$/;
function allowReason(row, lang) {
  if (!row)
    return null;
  const sources = lang === "other" ? [row.line.text] : row.lexed.comments;
  for (const text of sources) {
    const m = ALLOW.exec(text);
    if (!m)
      continue;
    const reason = m[1].replace(/(\*\/|-->)\s*$/, "").replace(/["',\s]+$/, "").trim();
    if (reason)
      return reason;
  }
  return null;
}
function allowForNew(hunk, idx, lang) {
  const own = allowReason(hunk.rows[idx], lang);
  if (own)
    return own;
  for (let k = idx - 1;k >= 0; k--) {
    const row = hunk.rows[k];
    if (row.line.kind !== "-")
      return allowReason(row, lang);
  }
  return null;
}
function allowForOld(hunk, idx, lang) {
  const added = (row) => row && row.line.kind === "+" ? allowReason(row, lang) : null;
  let k = idx;
  while (k >= 0 && hunk.rows[k].line.kind === "-")
    k--;
  const above = added(hunk.rows[k]);
  if (above)
    return above;
  k = idx;
  while (k < hunk.rows.length && hunk.rows[k].line.kind === "-")
    k++;
  return added(hunk.rows[k]);
}
var TEST_FN = "(?:it|test|describe|context|suite|specify)";
var JS_SKIP = [
  { re: new RegExp(`\\b${TEST_FN}(?:\\.\\w+)*\\.(?:skip|skipIf|fixme)\\b`) },
  { re: /(?<![\w$.])(?:xit|xdescribe|xtest|xcontext|xspecify)\s*\(/, testOnly: true },
  { re: /\bthis\.skip\s*\(/, testOnly: true }
];
var PY_SKIP = [
  { re: /\bpytest\.mark\.(?:skip|skipif|xfail)\b/ },
  { re: /\bpytest\.(?:skip|xfail)\s*\(/ },
  { re: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/ },
  { re: /^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b/ },
  { re: /\bself\.skipTest\s*\(/ },
  { re: /\braise\s+(?:unittest\.)?SkipTest\b/ }
];
var JS_ONLY = [
  { re: new RegExp(`\\b${TEST_FN}(?:\\.\\w+)*\\.only\\b`) },
  { re: /(?<![\w$.])(?:fit|fdescribe|ftest|fcontext)\s*\(/, testOnly: true }
];
var JS_TYPE_DIRECTIVE = /^@ts-(?:ignore|expect-error|nocheck)\b/;
var JS_LINT_DIRECTIVE = /^(?:eslint-disable|biome-ignore|oxlint-disable|tslint:disable|istanbul\s+ignore|c8\s+ignore|v8\s+ignore)\b/;
var PY_TYPE_DIRECTIVE = /^(?:type:\s*ignore|pyright:\s*ignore|mypy:\s*ignore-errors)\b/;
var PY_LINT_DIRECTIVE = /^(?:noqa|(?:ruff|flake8):\s*noqa|pylint:\s*disable|nosec|pragma:\s*no\s*cover)\b/i;
function directiveClasses(lexed, lang) {
  const found = new Set;
  for (const comment of lexed.comments) {
    if (lang === "js") {
      const body = comment.replace(/^[\s*/!]+/, "");
      if (JS_TYPE_DIRECTIVE.test(body))
        found.add("type-suppress");
      if (JS_LINT_DIRECTIVE.test(body))
        found.add("lint-suppress");
    } else {
      for (const segment of comment.split("#")) {
        const body = segment.trim();
        if (PY_TYPE_DIRECTIVE.test(body))
          found.add("type-suppress");
        if (PY_LINT_DIRECTIVE.test(body))
          found.add("lint-suppress");
      }
    }
  }
  return [...found];
}
function matches(patterns, code, test) {
  return patterns.some((p) => (!p.testOnly || test) && p.re.test(code));
}
function addedLineFindings(f) {
  if (f.lang === "other")
    return [];
  const out = [];
  for (const hunk of f.hunks) {
    hunk.rows.forEach((row, idx) => {
      if (row.line.kind !== "+")
        return;
      const classes = directiveClasses(row.lexed, f.lang);
      const code = row.lexed.masked;
      if (matches(f.lang === "js" ? JS_SKIP : PY_SKIP, code, f.test))
        classes.push("skip");
      if (f.lang === "js" && matches(JS_ONLY, code, f.test))
        classes.push("only");
      if (classes.length === 0)
        return;
      const allowed = allowForNew(hunk, idx, f.lang);
      for (const cls of classes)
        out.push(finding(f.path, row, cls, allowed));
    });
  }
  return out;
}
function finding(file, row, cls, allowed) {
  const side = row.line.kind === "-" ? "old" : "new";
  const line = (side === "old" ? row.line.oldLine : row.line.newLine) ?? 0;
  const f = { file, line, side, class: cls, text: row.line.text.trim() };
  if (allowed)
    f.allowed = allowed;
  return f;
}
var ASSERTIONS = [
  /\b(?:expect|assert\w*)(?:\.\w+)*\s*\(/,
  /\.should\b/,
  /\bt\.(?:is|not|true|false|deepEqual|notDeepEqual|equal|notEqual|same|throws|throwsAsync|ok|notOk|match|truthy|falsy|snapshot|like)\s*\(/,
  /^\s*assert\b/,
  /\bpytest\.(?:raises|warns)\s*\(/
];
var normalize = (s) => s.trim().replace(/\s+/g, " ").replace(/[;,]+$/, "");
function rowsOf(f, kind, keep) {
  const out = [];
  for (const hunk of f.hunks) {
    hunk.rows.forEach((row, idx) => {
      if (row.line.kind === kind && keep(row))
        out.push({ hunk, idx, row });
    });
  }
  return out;
}
function changeBlock(loc) {
  let k = loc.idx;
  while (k > 0 && loc.hunk.rows[k - 1].line.kind !== " ")
    k--;
  return k;
}
var isAssertion = (row) => ASSERTIONS.some((re) => re.test(row.lexed.masked));
function assertRemovedFindings(files) {
  const code = files.filter((f) => f.lang !== "other");
  const added = code.flatMap((f) => rowsOf(f, "+", isAssertion));
  const pool = new Map;
  for (const a of added) {
    const key = normalize(a.row.line.text);
    pool.set(key, [...pool.get(key) ?? [], a]);
  }
  const claimed = new Set;
  const targets = files.filter((f) => f.test && f.file.status !== "deleted");
  const unmatched = targets.flatMap((f) => rowsOf(f, "-", isAssertion).filter((r) => {
    const twin = pool.get(normalize(r.row.line.text))?.shift();
    if (twin)
      claimed.add(twin);
    return !twin;
  }).map((r) => ({ f, r })));
  const rewrites = new Map;
  for (const a of added) {
    if (claimed.has(a))
      continue;
    const blocks = rewrites.get(a.hunk) ?? new Map;
    blocks.set(changeBlock(a), (blocks.get(changeBlock(a)) ?? 0) + 1);
    rewrites.set(a.hunk, blocks);
  }
  return unmatched.filter(({ r }) => {
    const blocks = rewrites.get(r.hunk);
    const n = blocks?.get(changeBlock(r)) ?? 0;
    if (n > 0)
      blocks.set(changeBlock(r), n - 1);
    return n === 0;
  }).map(({ f, r }) => finding(f.path, r.row, "assert-removed", allowForOld(r.hunk, r.idx, f.lang)));
}
var JS_TEST_HEAD = /\b(?:it|test|specify)(?:\.\w+)*\s*\(\s*(["'`])/g;
var PY_TEST_DEF = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/;
function testName(row, lang) {
  const { masked } = row.lexed;
  if (lang === "py")
    return PY_TEST_DEF.exec(masked)?.[1] ?? null;
  if (lang !== "js")
    return null;
  JS_TEST_HEAD.lastIndex = 0;
  const m = JS_TEST_HEAD.exec(masked);
  if (!m)
    return null;
  const open = m.index + m[0].length;
  const close = masked.indexOf(m[1], open);
  return row.line.text.slice(open, close < 0 ? undefined : close);
}
var basename = (path) => path.slice(path.lastIndexOf("/") + 1);
function testDeletedFindings(files) {
  const defs = (f, kind) => rowsOf(f, kind, (row) => testName(row, f.lang) !== null).map((loc) => ({ loc, name: testName(loc.row, f.lang) }));
  const tests = files.filter((f) => f.test).map((f) => ({ f, added: defs(f, "+"), removed: defs(f, "-") }));
  const pool = new Map;
  for (const { added } of tests) {
    for (const d of added)
      pool.set(d.name, [...pool.get(d.name) ?? [], d.loc]);
  }
  const claimed = new Set;
  const missingOf = (removed) => removed.filter((d) => {
    const loc = pool.get(d.name)?.shift();
    if (loc)
      claimed.add(loc);
    return !loc;
  });
  const matched = tests.map((t) => ({ ...t, missing: missingOf(t.removed) }));
  const addedBasenames = new Set(files.filter((f) => f.file.status !== "deleted" && f.file.newPath).map((f) => basename(f.path)));
  const out = [];
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
var CONFIG_NAMES = new Set([
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
  "Makefile"
]);
function isThresholdConfig(path) {
  const name = basename(path);
  return CONFIG_NAMES.has(name) || /^(?:jest|vitest|vite|karma)\.config\.[cm]?[jt]s$/.test(name) || /^(?:jest|vitest)\.config\.json$/.test(name) || /^\.?eslintrc(?:\.\w+)?$/.test(name) || /^eslint\.config\.[cm]?[jt]s$/.test(name) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}
var THRESHOLD = /(?<![\w-])(?:--)?["']?(branches|lines|functions|statements|cov-fail-under|fail[_-]under|max[_-]?warnings|max[_-]complexity|max[_-]line[_-]length)["']?\s*(?:[:=]\s*|\s+)["']?(-?\d+(?:\.\d+)?)/gi;
function thresholdsOn(loc, path) {
  let text = loc.row.line.text;
  if (!/\.json$|^\.nycrc$|^\.c8rc$/.test(basename(path)))
    text = text.replace(/(^|\s)#.*$/, "").replace(/^\s*;.*$/, "");
  const out = [];
  for (const m of text.matchAll(THRESHOLD)) {
    const key = m[1].toLowerCase().replace(/[-_]/g, "").replace(/^cov/, "");
    out.push({ key, value: Number(m[2]), loc });
  }
  return out;
}
var isMaximum = (key) => key.startsWith("max");
function thresholdFindings(f) {
  if (!isThresholdConfig(f.path))
    return [];
  const all = (kind) => rowsOf(f, kind, () => true).flatMap((loc) => thresholdsOn(loc, f.path));
  const removed = all("-");
  const added = all("+");
  const used = new Set;
  const pair = (r, sameHunk) => added.find((a) => !used.has(a) && a.key === r.key && (!sameHunk || a.loc.hunk === r.loc.hunk));
  const out = [];
  const pending = [];
  for (const sameHunk of [true, false]) {
    for (const r of sameHunk ? removed : pending.splice(0)) {
      const a = pair(r, sameHunk);
      if (!a) {
        if (sameHunk)
          pending.push(r);
        else
          out.push(finding(f.path, r.loc.row, "threshold-lowered", allowForOld(r.loc.hunk, r.loc.idx, f.lang)));
        continue;
      }
      used.add(a);
      const weaker = isMaximum(r.key) ? a.value > r.value : a.value < r.value;
      if (weaker)
        out.push(finding(f.path, a.loc.row, "threshold-lowered", allowForNew(a.loc.hunk, a.loc.idx, f.lang)));
    }
  }
  return dedupe(out);
}
function dedupe(findings) {
  const seen = new Set;
  return findings.filter((x) => {
    const key = `${x.file}\x00${x.side}\x00${x.line}\x00${x.class}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function sortFindings(findings) {
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) || (a.class < b.class ? -1 : a.class > b.class ? 1 : 0));
}
function detectFiles(files) {
  const lexed = files.filter((f) => !f.binary).map(lexFile);
  const findings = [
    ...lexed.flatMap(addedLineFindings),
    ...assertRemovedFindings(lexed),
    ...testDeletedFindings(lexed),
    ...lexed.flatMap(thresholdFindings)
  ];
  return sortFindings(dedupe(findings));
}

// src/scope.ts
function parseScope(text) {
  const lines = text.replace(/\r\n/g, `
`).split(`
`);
  const start = lines.findIndex((l) => /^\s*scope:/i.test(l));
  if (start < 0)
    return null;
  const patterns = [];
  const inline = lines[start].replace(/^\s*scope:/i, "").replace(/\s#.*$/, "").trim();
  if (inline)
    patterns.push(...inline.replace(/^\[|\]$/g, "").split(","));
  else {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*$/.test(line) || /^\s*#/.test(line))
        continue;
      const item = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (!item)
        break;
      patterns.push(item[1].replace(/\s#.*$/, ""));
    }
  }
  const clean = patterns.map((p) => p.trim().replace(/^["'`]|["'`]$/g, "").trim()).filter(Boolean);
  return clean.length > 0 ? clean : null;
}
function globToRegExp(glob) {
  const g = glob.replace(/^\.?\//, "").replace(/\/$/, "/**");
  let re = "";
  for (let i = 0;i < g.length; i++) {
    const ch = g[i];
    if (ch === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*")
      re += "[^/]*";
    else if (ch === "?")
      re += "[^/]";
    else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0)
        re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map(escape).join("|")})`;
        i = end;
      }
    } else
      re += escape(ch);
  }
  const literal = !/[*?{]/.test(g);
  return new RegExp(`^${re}${literal ? "(?:/.*)?" : ""}$`);
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function inScope(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}
function scopeFindings(files, ...patternSets) {
  const allowed = (p) => patternSets.every((patterns) => inScope(p, patterns));
  return files.filter((f) => [f.oldPath, f.newPath].some((p) => p !== null && !allowed(p))).map((f) => {
    const old = f.newPath === null;
    const text = f.status === "renamed" ? `${f.oldPath} -> ${f.newPath} (${f.status})` : `${displayPath(f)} (${f.status})`;
    return { file: displayPath(f), line: 0, side: old ? "old" : "new", class: "out-of-scope", text };
  });
}

// src/action.ts
function gate(input) {
  const files = parseDiff(input.diff);
  const file = input.scopeFile === null ? null : parseScope(input.scopeFile);
  const scope = {
    file,
    body: parseScope(input.body),
    fileWithoutPatterns: input.scopeFile !== null && file === null
  };
  const sets = [scope.file, scope.body].filter((s) => s !== null);
  const findings = sortFindings([...detectFiles(files), ...sets.length > 0 ? scopeFindings(files, ...sets) : []]);
  const blocking = findings.filter((f) => !f.allowed).length;
  const exitCode = input.mode === "block" && blocking > 0 ? 1 : 0;
  return { findings, scope, exitCode, summary: renderSummary(findings, scope, input.mode, exitCode) };
}
function parseMode(raw) {
  const mode = (raw ?? "").trim().toLowerCase() || "warn";
  if (mode !== "warn" && mode !== "block")
    throw new Error(`input "mode" must be "warn" or "block", got "${raw}"`);
  return mode;
}
var MAX_ROWS = 300;
var html = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ");
function lineLabel(f) {
  if (f.line === 0)
    return "file";
  return f.side === "old" ? `${f.line} (old)` : String(f.line);
}
function renderSummary(findings, scope, mode, exitCode) {
  const allowed = findings.filter((f) => f.allowed).length;
  const open = findings.length - allowed;
  const out = ["## agent-pr-gate", ""];
  out.push(`**Mode:** \`${mode}\` · **Findings:** ${findings.length} (${open} unallowed, ${allowed} allowed) · detector ${DETECTOR_VERSION}`, "");
  const list = (patterns) => patterns.map((p) => `<code>${html(p)}</code>`).join(", ");
  if (scope.file)
    out.push(`**Scope** from \`.agent-scope.yml\` on the base branch: ${list(scope.file)}`, "");
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
    const status = (f) => f.allowed ? `allowed: ${html(f.allowed)}` : mode === "block" ? "**blocking**" : "warning";
    out.push("| Class | File | Line | Code | Status |", "|---|---|---|---|---|");
    for (const f of findings.slice(0, MAX_ROWS)) {
      out.push(`| ${f.class} | <code>${html(f.file)}</code> | ${lineLabel(f)} | <code>${html(f.text)}</code> | ${status(f)} |`);
    }
    if (findings.length > MAX_ROWS)
      out.push("", `_${findings.length - MAX_ROWS} more findings not shown._`);
    out.push("");
  }
  out.push(exitCode === 1 ? `**Result:** blocked, ${open} unallowed finding${open === 1 ? "" : "s"}. Fix them or justify each with a \`gate-allow: <reason>\` comment.` : open > 0 ? `**Result:** passed in warn mode with ${open} unallowed finding${open === 1 ? "" : "s"}.` : "**Result:** passed.", "");
  return out.join(`
`);
}
var cmdData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var cmdProp = (s) => cmdData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
function annotations(findings, mode) {
  return findings.filter((f) => !f.allowed).map((f) => {
    const props = [`file=${cmdProp(f.file)}`];
    if (f.line > 0 && f.side === "new")
      props.push(`line=${f.line}`);
    props.push(`title=${cmdProp(`agent-pr-gate: ${f.class}`)}`);
    return `::${mode === "block" ? "error" : "warning"} ${props.join(",")}::${cmdData(f.text)}`;
  });
}
function readPullRequest(eventPath) {
  const payload = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr || typeof pr.number !== "number" || typeof pr.base?.sha !== "string") {
    throw new Error("event payload has no pull_request with number and base.sha");
  }
  return { number: pr.number, body: typeof pr.body === "string" ? pr.body : "", baseSha: pr.base.sha };
}
async function getText(fetchImpl, url, token, accept) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-pr-gate",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 404)
    return null;
  if (!res.ok)
    throw new Error(`GET ${url} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.text();
}
async function run(env, fetchImpl = fetch, log = console.log) {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "pull_request_target") {
    log(`::notice title=agent-pr-gate::skipped: event "${event ?? "unknown"}" is not a pull_request event`);
    return 0;
  }
  const mode = parseMode(env.INPUT_MODE);
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  if (!token)
    throw new Error("no token: set the `token` input or GITHUB_TOKEN");
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY)
    throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY must be set");
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const repo = env.GITHUB_REPOSITORY;
  const pr = readPullRequest(env.GITHUB_EVENT_PATH);
  const diff = await getText(fetchImpl, `${api}/repos/${repo}/pulls/${pr.number}`, token, "application/vnd.github.v3.diff");
  if (diff === null)
    throw new Error(`pull request #${pr.number} not found in ${repo}`);
  const scopeFile = await getText(fetchImpl, `${api}/repos/${repo}/contents/.agent-scope.yml?ref=${encodeURIComponent(pr.baseSha)}`, token, "application/vnd.github.raw");
  const result = gate({ diff, body: pr.body, scopeFile, mode });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary);
  else
    log(result.summary);
  for (const line of annotations(result.findings, mode))
    log(line);
  return result.exitCode;
}
var invokedDirectly = process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  run(process.env).then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.log(`::error title=agent-pr-gate::${cmdData(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
  });
}
export {
  annotations,
  gate,
  parseMode,
  renderSummary,
  run
};
