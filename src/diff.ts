// Unified diff parser for `git diff` / GitHub `application/vnd.github.v3.diff` output.

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffLine {
  kind: "+" | "-" | " ";
  text: string;
  /** Line number in the old file; set for "-" and " " lines. */
  oldLine?: number;
  /** Line number in the new file; set for "+" and " " lines. */
  newLine?: number;
}

export interface Hunk {
  lines: DiffLine[];
  /** Text after the closing `@@` of the hunk header: git's guess at the enclosing function, often empty. */
  context: string;
}

export interface FileDiff {
  /** Path before the change; null when the file was added. */
  oldPath: string | null;
  /** Path after the change; null when the file was deleted. */
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

/** The path a finding about this file should name: the new path, or the old one for deletions. */
export function displayPath(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? "";
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
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
        // An empty line inside a hunk is a context line whose leading space was stripped.
        hunk.lines.push({ kind: " ", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (kind === "\\") continue; // "\ No newline at end of file"
      // Anything else means the hunk header counts lied; fall through and treat as a header line.
      hunk = null;
    }
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, status: "modified", binary: false, hunks: [] };
      const [a, b] = splitGitHeader(line.slice("diff --git ".length));
      file.oldPath = a;
      file.newPath = b;
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue; // preamble before the first file header

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
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) file.oldPath = stripPrefix(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) file.newPath = stripPrefix(line.slice(4), "b/");
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
  }

  for (const f of files) {
    if (f.status === "added") f.oldPath = null;
    if (f.status === "deleted") f.newPath = null;
    if (f.oldPath === null && f.status === "modified") f.status = "added";
    if (f.newPath === null && f.status === "modified") f.status = "deleted";
  }
  return files;
}

function stripPrefix(raw: string, prefix: string): string | null {
  const path = unquote(raw.replace(/\t.*$/, ""));
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Splits "a/x b/y" from a `diff --git` header. Paths may be quoted or contain spaces. */
function splitGitHeader(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const a = unquote(rest.slice(0, end + 1));
    const b = unquote(rest.slice(end + 2));
    return [strip(a, "a/"), strip(b, "b/")];
  }
  const quoted = rest.indexOf(' "b/');
  if (quoted >= 0) return [strip(rest.slice(0, quoted), "a/"), strip(unquote(rest.slice(quoted + 1)), "b/")];
  // Unquoted: for the common same-path case the header is "a/P b/P"; split at the middle.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " " && rest.slice(2, mid) === rest.slice(mid + 3)) {
    return [rest.slice(2, mid), rest.slice(mid + 3)];
  }
  const sep = rest.indexOf(" b/");
  if (sep < 0) return [null, null];
  return [strip(rest.slice(0, sep), "a/"), strip(rest.slice(sep + 1), "b/")];
}

function strip(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function closingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };

/** Undoes git's C-style path quoting, including octal-escaped UTF-8 bytes. */
function unquote(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
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
