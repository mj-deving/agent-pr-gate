import { describe, expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { fileDiff } from "./helpers.ts";

describe("parseDiff", () => {
  test("tracks old and new line numbers across a hunk", () => {
    const [file] = parseDiff(fileDiff("src/a.ts", [" one", "-two", "+TWO", " three"], { oldStart: 10, newStart: 20 }));
    expect(file!.status).toBe("modified");
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: " ", text: "one", oldLine: 10, newLine: 20 },
      { kind: "-", text: "two", oldLine: 11 },
      { kind: "+", text: "TWO", newLine: 21 },
      { kind: " ", text: "three", oldLine: 12, newLine: 22 },
    ]);
  });

  test("reads added, deleted and renamed files", () => {
    const diff =
      fileDiff("new.ts", ["+x"], { status: "added" }) +
      fileDiff("gone.ts", ["-y"], { status: "deleted" }) +
      fileDiff("to/b.ts", [], { renamedFrom: "from/b.ts" });
    const files = parseDiff(diff);
    expect(files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ["added", null, "new.ts"],
      ["deleted", "gone.ts", null],
      ["renamed", "from/b.ts", "to/b.ts"],
    ]);
  });

  test("hunk bodies that look like headers stay content", () => {
    const [file] = parseDiff(fileDiff("doc.md", ["---- a/x", "+++ b/y"]));
    expect(file!.hunks[0]!.lines.map((l) => l.kind + l.text)).toEqual(["---- a/x", "+++ b/y"]);
    expect(file!.newPath).toBe("doc.md");
  });

  test("unquotes paths with spaces and non-ASCII characters", () => {
    const diff = [
      'diff --git "a/dir/caf\\303\\251 x.ts" "b/dir/caf\\303\\251 x.ts"',
      "--- \"a/dir/caf\\303\\251 x.ts\"",
      "+++ \"b/dir/caf\\303\\251 x.ts\"",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parseDiff(diff)[0]!.newPath).toBe("dir/café x.ts");
  });

  test("marks binary files", () => {
    const diff = "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n";
    expect(parseDiff(diff)[0]!.binary).toBe(true);
  });

  test("ignores the no-newline marker", () => {
    const [file] = parseDiff(fileDiff("a.ts", ["-x", "\\ No newline at end of file", "+y"]).replace("-1,2 +1,2", "-1,1 +1,1"));
    expect(file!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["-", "+"]);
  });
});
