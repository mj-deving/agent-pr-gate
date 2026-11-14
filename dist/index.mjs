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
      hunk = { lines: [], context: line.slice(header[0].length).trim() };
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
var DETECTOR_VERSION = "0.4.0";
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
    return { rows, context: hunk.context };
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
var isAssertion = (row) => ASSERTIONS.some((re) => re.test(row.lexed.masked));
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
function closing(s, open) {
  let depth = 0;
  for (let i = open;i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{")
      depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0)
      return i;
  }
  return -1;
}
function items(s, open, close) {
  const out = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1;i < close; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{")
      depth++;
    else if (c === ")" || c === "]" || c === "}")
      depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start, close));
  return out.map((p) => p.trim()).filter(Boolean);
}
function literalCount(expr) {
  const t = expr.trim();
  if (!/^[[(]/.test(t) || closing(t, 0) !== t.length - 1)
    return 1;
  const parts = items(t, 0, t.length - 1);
  if (parts.some((p) => /\bfor\b/.test(p)))
    return 1;
  return Math.max(1, parts.length);
}
function sideText(hunk, side) {
  const t = { idxs: [], starts: [], masked: "", raw: "" };
  const skip = side === "old" ? "+" : "-";
  hunk.rows.forEach((row, idx) => {
    if (row.line.kind === skip)
      return;
    t.idxs.push(idx);
    t.starts.push(t.masked.length);
    t.masked += `${row.lexed.masked}
`;
    t.raw += `${row.line.text}
`;
  });
  return t;
}
function sideRowAt(t, offset) {
  let lo = 0;
  let hi = t.starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (t.starts[mid] <= offset)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo;
}
var indentOf = (text) => text.length - text.trimStart().length;
var PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
function pyDefs(t) {
  const out = [];
  let pending = [];
  let resumeAt = 0;
  for (let k = 0;k < t.idxs.length; k++) {
    const start = t.starts[k];
    if (start < resumeAt)
      continue;
    const line = t.masked.slice(start, (t.starts[k + 1] ?? t.masked.length + 1) - 1);
    const code = line.trim();
    if (!code)
      continue;
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
      out.push({ at: k, through: close < 0 ? k : sideRowAt(t, close), name: m[2], decorators: pending.filter((d) => d.indent === indent).map((d) => d.text), args });
    }
    pending = [];
  }
  return out;
}
function parametrizeRows(decorator) {
  const m = /\bparametrize\s*\(/.exec(decorator);
  if (!m)
    return 1;
  const open = m.index + m[0].length - 1;
  const close = closing(decorator, open);
  if (close < 0)
    return 1;
  const args = items(decorator, open, close);
  const keyword = args.find((a) => /^argvalues\s*=/.test(a));
  const values = keyword ? keyword.replace(/^argvalues\s*=/, "") : args.filter((a) => !/^\w+\s*=/.test(a))[1];
  return values ? literalCount(values) : 1;
}
function fixtureParams(decorator) {
  if (!/\bfixture\b/.test(decorator))
    return null;
  const m = /\bparams\s*=\s*/.exec(decorator);
  if (!m)
    return null;
  const rest = decorator.slice(m.index + m[0].length);
  const close = /^[[(]/.test(rest) ? closing(rest, 0) : -1;
  return close < 0 ? 1 : literalCount(rest.slice(0, close + 1));
}
var JS_HEAD = /(?<![\w$.])(?<!\bfunction\s+)(?:it|test|specify)((?:\.\w+)*)\s*([(`])/g;
var JS_MODIFIER = /^(?:only|skip|todo|fails|failing|concurrent|sequential|each|skipIf|runIf|fixme)$/;
function jsHeads(t) {
  const out = [];
  for (const m of t.masked.matchAll(JS_HEAD)) {
    const chain = m[1].split(".").filter(Boolean);
    if (!chain.every((c) => JS_MODIFIER.test(c)))
      continue;
    const at = sideRowAt(t, m.index);
    let pos = m.index + m[0].length - 1;
    let rows = 1;
    if (m[2] === "`" || chain.some((c) => c === "each" || c === "skipIf" || c === "runIf")) {
      const close = m[2] === "`" ? t.masked.indexOf("`", pos + 1) : closing(t.masked, pos);
      if (close < 0) {
        out.push({ at, through: sideRowAt(t, pos), name: "", rows });
        continue;
      }
      if (chain.includes("each")) {
        rows = m[2] === "`" ? Math.max(1, t.raw.slice(pos + 1, close).split(`
`).filter((l) => l.trim()).length - 1) : literalCount(t.masked.slice(pos + 1, close));
      }
      pos = close + 1;
      while (/\s/.test(t.masked[pos] ?? ""))
        pos++;
      if (t.masked[pos] !== "(") {
        out.push({ at, through: sideRowAt(t, pos), name: "", rows });
        continue;
      }
    }
    let q = pos + 1;
    while (/\s/.test(t.masked[q] ?? ""))
      q++;
    const quote = t.masked[q];
    const end = quote === "'" || quote === '"' || quote === "`" ? t.masked.indexOf(quote, q + 1) : -1;
    out.push({ at, through: sideRowAt(t, Math.min(q, t.masked.length - 1)), name: end < 0 ? "" : t.raw.slice(q + 1, end), rows });
  }
  return out;
}
function headerTest(context, lang) {
  if (lang === "py")
    return /^(?:async\s+)?def\s+(test\w*)/.exec(context)?.[1] ?? "";
  return /^(?:it|test|specify)(?:\.\w+)*\s*\(\s*(["'`])(.*?)\1/.exec(context)?.[2] ?? "";
}
function buildLedger(files) {
  const tests = files.filter((f) => f.test && f.lang !== "other");
  const sides = ["old", "new"];
  const texts = new Map;
  for (const f of tests) {
    for (const h of f.hunks)
      texts.set(h, { old: sideText(h, "old"), new: sideText(h, "new") });
  }
  const fixtures = { old: new Map, new: new Map };
  const defs = new Map;
  for (const f of tests.filter((x) => x.lang === "py")) {
    for (const h of f.hunks) {
      for (const side of sides) {
        const t = texts.get(h)[side];
        const found = pyDefs(t);
        defs.set(t, found);
        for (const d of found) {
          const n = d.decorators.map(fixtureParams).find((x) => x !== null);
          if (n != null)
            fixtures[side].set(d.name, n);
        }
      }
    }
  }
  const ledger = { heads: new Map, owners: { old: new Map, new: new Map } };
  for (const f of tests) {
    const heads = { old: [], new: [] };
    for (const hunk of f.hunks) {
      for (const side of sides) {
        const t = texts.get(hunk)[side];
        const found = f.lang === "py" ? defs.get(t).filter((d) => d.name.startsWith("test")).map((d) => ({
          at: d.at,
          through: d.through,
          name: d.name,
          rows: d.decorators.reduce((n, dec) => n * parametrizeRows(dec), 1) * d.args.reduce((n, a) => n * (fixtures[side].get(a) ?? 1), 1)
        })) : jsHeads(t);
        const byRow = new Map;
        for (const x of found) {
          if (byRow.has(x.at))
            continue;
          const idx = t.idxs[x.at];
          const row = hunk.rows[idx];
          const head = { file: f, hunk, idx, row, name: x.name, rows: x.rows, indent: indentOf(row.line.text), through: x.through };
          byRow.set(x.at, head);
          heads[side].push(head);
        }
        const header = headerTest(hunk.context, f.lang);
        const stack = [];
        let seenHead = false;
        t.idxs.forEach((idx, k) => {
          const row = hunk.rows[idx];
          if (row.lexed.masked.trim()) {
            const indent = indentOf(row.line.text);
            while (stack.length && stack[stack.length - 1].indent >= indent && stack[stack.length - 1].through < k)
              stack.pop();
            const own = byRow.get(k);
            if (own) {
              stack.push(own);
              seenHead = true;
            }
          }
          const owner = stack[stack.length - 1] ?? (!seenHead && header ? { header } : null);
          ledger.owners[side].set(row, owner);
        });
      }
    }
    ledger.heads.set(f, heads);
  }
  return ledger;
}
var isRemoved = (h) => h.row.line.kind === "-";
var isAdded = (h) => h.row.line.kind === "+";
var basename = (path) => path.slice(path.lastIndexOf("/") + 1);
function judgeTests(files, ledger) {
  const partner = new Map;
  const findings = [];
  const spare = new Map;
  for (const { old, new: now } of ledger.heads.values()) {
    const before = new Map(old.map((h) => [h.row, h.rows]));
    for (const h of now)
      spare.set(h, isAdded(h) ? h.rows : Math.max(0, h.rows - (before.get(h.row) ?? h.rows)));
  }
  const byName = new Map;
  for (const { new: now } of ledger.heads.values()) {
    for (const h of now.filter((x) => isAdded(x) && x.name))
      byName.set(h.name, [...byName.get(h.name) ?? [], h]);
  }
  const missingIn = new Map;
  for (const [f, { old }] of ledger.heads) {
    const missing = [];
    for (const r of old.filter(isRemoved)) {
      const twin = r.name ? byName.get(r.name)?.shift() : undefined;
      if (twin) {
        partner.set(r, twin);
        spare.set(twin, spare.get(twin) - 1);
      } else
        missing.push(r);
    }
    missingIn.set(f, missing);
  }
  for (const f of files) {
    const from = f.file.oldPath;
    if (f.file.status === "renamed" && from && isTestFile(from) && !f.test) {
      findings.push({ file: f.path, line: 0, side: "new", class: "test-deleted", text: `test file renamed out of the test convention (from ${from})` });
    }
  }
  const addedBasenames = new Set(files.filter((f) => f.file.status !== "deleted" && f.file.newPath).map((f) => basename(f.path)));
  for (const [f, { old, new: now }] of ledger.heads) {
    const missing = missingIn.get(f);
    if (f.file.status === "deleted") {
      const removed = old.filter(isRemoved).length;
      const moved = removed > 0 ? missing.length === 0 : addedBasenames.has(basename(f.path));
      if (!moved) {
        const detail = removed > 0 ? `${missing.length} of ${removed} tests not re-added` : "no tests re-added";
        findings.push({ file: f.path, line: 0, side: "old", class: "test-deleted", text: `deleted test file (${detail})` });
      }
      continue;
    }
    const take = (h) => {
      if (h)
        spare.set(h, spare.get(h) - 1);
      return h;
    };
    const unexplained = missing.filter((r) => {
      const renamed = take(now.find((a) => isAdded(a) && spare.get(a) > 0 && a.hunk === r.hunk && changeBlock(a) === changeBlock(r)));
      if (renamed)
        partner.set(r, renamed);
      return !renamed;
    });
    for (const r of unexplained) {
      if (take(now.find((a) => a.rows > 1 && spare.get(a) > 0)))
        continue;
      findings.push(finding(f.path, r.row, "test-deleted", allowForOld(r.hunk, r.idx, f.lang)));
    }
  }
  return { partner, findings };
}
function judgeAssertions(files, ledger, partner) {
  const keyOf = (h) => `${h.file.path}\x00${h.name || `#${h.file.hunks.indexOf(h.hunk)}:${h.idx}`}`;
  const account = (path, owner) => {
    if (!owner)
      return null;
    if ("header" in owner)
      return { key: `${path}\x00${owner.header}`, weight: 1 };
    if (!isRemoved(owner))
      return { key: keyOf(owner), weight: owner.rows };
    const now = partner.get(owner);
    return now ? { key: keyOf(now), weight: owner.rows } : "judged-with-test";
  };
  const code = files.filter((f) => f.lang !== "other");
  const added = code.flatMap((f) => rowsOf(f, "+", isAssertion).map((loc) => ({ f, loc })));
  const pool = new Map;
  for (const { loc } of added) {
    const key = normalize(loc.row.line.text);
    pool.set(key, [...pool.get(key) ?? [], loc]);
  }
  const claimed = new Set;
  const targets = files.filter((f) => f.test && f.file.status !== "deleted");
  const unmatched = targets.flatMap((f) => rowsOf(f, "-", isAssertion).filter((loc) => {
    const twin = pool.get(normalize(loc.row.line.text))?.shift();
    if (twin)
      claimed.add(twin);
    return !twin;
  }).map((loc) => ({ f, loc })));
  const budget = new Map;
  const blocks = new Map;
  for (const { f, loc } of added) {
    if (claimed.has(loc))
      continue;
    const acc = account(f.path, ledger.owners.new.get(loc.row));
    if (acc && acc !== "judged-with-test") {
      budget.set(acc.key, (budget.get(acc.key) ?? 0) + acc.weight);
      continue;
    }
    const perBlock = blocks.get(loc.hunk) ?? new Map;
    perBlock.set(changeBlock(loc), (perBlock.get(changeBlock(loc)) ?? 0) + 1);
    blocks.set(loc.hunk, perBlock);
  }
  const out = [];
  for (const { f, loc } of unmatched) {
    const acc = account(f.path, ledger.owners.old.get(loc.row));
    if (acc === "judged-with-test")
      continue;
    let offset;
    if (acc) {
      const left = budget.get(acc.key) ?? 0;
      offset = left >= acc.weight;
      if (offset)
        budget.set(acc.key, left - acc.weight);
    } else {
      const perBlock = blocks.get(loc.hunk);
      const n = perBlock?.get(changeBlock(loc)) ?? 0;
      offset = n > 0;
      if (offset)
        perBlock.set(changeBlock(loc), n - 1);
    }
    if (!offset)
      out.push(finding(f.path, loc.row, "assert-removed", allowForOld(loc.hunk, loc.idx, f.lang)));
  }
  return out;
}
function testAccountingFindings(files) {
  const ledger = buildLedger(files);
  const { partner, findings } = judgeTests(files, ledger);
  return [...judgeAssertions(files, ledger, partner), ...findings];
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
    ...testAccountingFindings(lexed),
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
