/** Builds a one-hunk git diff for `path`. Body lines carry their "+", "-" or " " prefix. */
export function fileDiff(
  path: string,
  body: string[],
  opts: { status?: "added" | "deleted"; renamedFrom?: string; oldStart?: number; newStart?: number } = {},
): string {
  const from = opts.renamedFrom ?? path;
  const out = [`diff --git a/${from} b/${path}`];
  if (opts.status === "added") out.push("new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`);
  else if (opts.status === "deleted") out.push("deleted file mode 100644", "index 1111111..0000000", `--- a/${path}`, "+++ /dev/null");
  else {
    if (opts.renamedFrom) out.push("similarity index 95%", `rename from ${from}`, `rename to ${path}`);
    out.push("index 1111111..2222222 100644", `--- a/${from}`, `+++ b/${path}`);
  }
  if (body.length === 0) return out.join("\n") + "\n";
  const oldCount = body.filter((l) => !l.startsWith("+")).length;
  const newCount = body.filter((l) => !l.startsWith("-")).length;
  const oldStart = opts.status === "added" ? 0 : (opts.oldStart ?? 1);
  const newStart = opts.status === "deleted" ? 0 : (opts.newStart ?? 1);
  out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  return out.join("\n") + "\n";
}

/** Shorthand: every line added to an existing file. */
export const added = (path: string, ...lines: string[]) => fileDiff(path, lines.map((l) => `+${l}`));
