import type { FileDiff } from "./diff.ts";
import { displayPath } from "./diff.ts";
import type { Finding } from "./detect.ts";

/**
 * Reads a `scope:` block of glob patterns from a PR body or `.agent-scope.yml`.
 * Accepted shapes (inside or outside a code fence):
 *
 *   scope: src/**, docs/*.md        scope: [src/**, docs/*.md]        scope:
 *                                                                      - src/**
 *                                                                      - "docs/*.md"
 *
 * Returns null when there is no `scope:` line, or when it lists no patterns.
 */
export function parseScope(text: string): string[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^\s*scope:/i.test(l));
  if (start < 0) return null;

  const patterns: string[] = [];
  const inline = lines[start]!.replace(/^\s*scope:/i, "").replace(/\s#.*$/, "").trim();
  if (inline) patterns.push(...inline.replace(/^\[|\]$/g, "").split(","));
  else {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      const item = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (!item) break;
      patterns.push(item[1]!.replace(/\s#.*$/, ""));
    }
  }
  const clean = patterns.map((p) => p.trim().replace(/^["'`]|["'`]$/g, "").trim()).filter(Boolean);
  return clean.length > 0 ? clean : null;
}

/**
 * Glob to RegExp: `**` spans directories, `*` and `?` stay within one segment, `{a,b}` alternates.
 * A pattern without wildcards also matches everything below it as a directory.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.?\//, "").replace(/\/$/, "/**");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map(escape).join("|")})`;
        i = end;
      }
    } else re += escape(ch);
  }
  const literal = !/[*?{]/.test(g);
  return new RegExp(`^${re}${literal ? "(?:/.*)?" : ""}$`);
}

// Known limit: wildcards inside `{a,b}` are literal; nest globToRegExp per alternative if anyone needs them.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function inScope(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/**
 * One out-of-scope finding per changed file that falls outside any of the pattern sets: a path is
 * in scope only when every set matches it, so a second set can narrow but never widen the first.
 * Renames must stay in scope on both ends.
 */
export function scopeFindings(files: FileDiff[], ...patternSets: string[][]): Finding[] {
  const allowed = (p: string) => patternSets.every((patterns) => inScope(p, patterns));
  return files
    .filter((f) => [f.oldPath, f.newPath].some((p) => p !== null && !allowed(p)))
    .map((f) => {
      const old = f.newPath === null;
      const text = f.status === "renamed" ? `${f.oldPath} -> ${f.newPath} (${f.status})` : `${displayPath(f)} (${f.status})`;
      return { file: displayPath(f), line: 0, side: old ? "old" : "new", class: "out-of-scope", text } satisfies Finding;
    });
}
