// Line lexer that separates code from string literals and comments.
// Known limit: hand-rolled, line-at-a-time, no regex-literal or nested-template awareness.
// Good enough to stop "it.skip" inside a string or comment from counting; swap in a real
// tokenizer (e.g. TypeScript's scanner) if the bench shows misses that trace back here.

export type Language = "js" | "py" | "other";

export function languageOf(path: string): Language {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "js";
  if (/\.pyi?$/.test(path)) return "py";
  return "other";
}

/** Multi-line constructs that carry over to the next line. */
export type LexState = "code" | "block-comment" | "template" | "triple-single" | "triple-double";

export interface LexedLine {
  /**
   * Same length as the input. Comment characters and the contents of string literals are
   * replaced by spaces; string delimiters stay. Regexes over `masked` see only code.
   */
  masked: string;
  /** The text of every comment on the line, without the comment markers. */
  comments: string[];
  state: LexState;
}

export function lexLine(line: string, lang: Language, state: LexState = "code"): LexedLine {
  if (lang === "js") return lexJs(line, state);
  if (lang === "py") return lexPy(line, state);
  return { masked: line, comments: [], state: "code" };
}

function lexJs(line: string, start: LexState): LexedLine {
  const out = line.split("");
  const comments: string[] = [];
  let state = start;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = " ";
  };

  while (i < line.length) {
    if (state === "block-comment") {
      const end = line.indexOf("*/", i);
      const stop = end < 0 ? line.length : end;
      comments.push(line.slice(i, stop));
      blank(i, end < 0 ? line.length : end + 2);
      if (end < 0) return { masked: out.join(""), comments, state };
      i = end + 2;
      state = "code";
      continue;
    }
    if (state === "template") {
      const end = findClose(line, i, "`");
      blank(i, end < 0 ? line.length : end);
      if (end < 0) return { masked: out.join(""), comments, state };
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

function lexPy(line: string, start: LexState): LexedLine {
  const out = line.split("");
  const comments: string[] = [];
  let state = start;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = " ";
  };

  while (i < line.length) {
    if (state === "triple-single" || state === "triple-double") {
      const delim = state === "triple-single" ? "'''" : '"""';
      const end = findClose(line, i, delim);
      blank(i, end < 0 ? line.length : end);
      if (end < 0) return { masked: out.join(""), comments, state };
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

/** Index of the next unescaped `delim` at or after `from`, or -1. */
function findClose(line: string, from: number, delim: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(delim, i)) return i;
  }
  return -1;
}
