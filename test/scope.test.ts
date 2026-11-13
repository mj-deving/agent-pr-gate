import { describe, expect, test } from "bun:test";
import { gate } from "../src/action.ts";
import { parseDiff } from "../src/diff.ts";
import { globToRegExp, parseScope, scopeFindings } from "../src/scope.ts";
import { added, fileDiff } from "./helpers.ts";

describe("parseScope", () => {
  test("plain markdown list in a PR body", () => {
    const body = "Fixes the parser.\n\nscope:\n- src/parser/**\n- test/parser.test.ts\n\nThanks!";
    expect(parseScope(body)).toEqual(["src/parser/**", "test/parser.test.ts"]);
  });

  test("fenced block with quotes and asterisk bullets", () => {
    const body = "## Task\n```yaml\nscope:\n  * \"src/**\"\n  * 'docs/*.md'\n```\n";
    expect(parseScope(body)).toEqual(["src/**", "docs/*.md"]);
  });

  test("inline comma list and flow sequence", () => {
    expect(parseScope("Scope: src/**, README.md")).toEqual(["src/**", "README.md"]);
    expect(parseScope("scope: [src/**, `lib/*.ts`]")).toEqual(["src/**", "lib/*.ts"]);
  });

  test(".agent-scope.yml with comments", () => {
    const yml = "# allowed paths for agents\nscope:\n  # core only\n  - src/**   # code\n  - test/**\nother: value\n";
    expect(parseScope(yml)).toEqual(["src/**", "test/**"]);
  });

  test("no scope block, or an empty one, is null", () => {
    expect(parseScope("This PR changes the scope of the parser.")).toBeNull();
    expect(parseScope("scope:\n\nnot a list")).toBeNull();
  });
});

describe("globToRegExp", () => {
  test.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/guide/x.md", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src", "src/a/b.ts", true],
    ["docs/", "docs/a.md", true],
    ["./lib/{a,b}.ts", "lib/b.ts", true],
    ["file?.txt", "file1.txt", true],
    ["a.b", "axb", false],
  ])("%s vs %s -> %p", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe("scopeFindings", () => {
  test("files outside the scope are reported, files inside are not", () => {
    const files = parseDiff(added("src/a.ts", "x") + added("infra/deploy.yml", "y"));
    expect(scopeFindings(files, ["src/**"])).toEqual([
      { file: "infra/deploy.yml", line: 0, side: "new", class: "out-of-scope", text: "infra/deploy.yml (modified)" },
    ]);
  });

  test("a rename out of the scope is reported", () => {
    const files = parseDiff(fileDiff("lib/a.ts", [], { renamedFrom: "src/a.ts" }));
    expect(scopeFindings(files, ["src/**"]).map((f) => f.text)).toEqual(["src/a.ts -> lib/a.ts (renamed)"]);
  });

  test("a deleted file outside the scope is reported on the old side", () => {
    const files = parseDiff(fileDiff("old/x.ts", ["-x"], { status: "deleted" }));
    expect(scopeFindings(files, ["src/**"])).toMatchObject([{ file: "old/x.ts", side: "old" }]);
  });
});

describe("scope inside the gate", () => {
  const diff = added("src/a.ts", "const a = 1;") + added("docs/b.md", "text");

  const outOfScope = (body: string, scopeFile: string | null) =>
    gate({ diff, body, scopeFile, mode: "warn" })
      .findings.filter((f) => f.class === "out-of-scope")
      .map((f) => f.file);

  test("PR body scope alone applies when the base has no scope file", () => {
    const r = gate({ diff, body: "scope:\n- src/**", scopeFile: null, mode: "warn" });
    expect(r.scope).toEqual({ file: null, body: ["src/**"], fileWithoutPatterns: false });
    expect(r.findings.map((f) => [f.class, f.file])).toEqual([["out-of-scope", "docs/b.md"]]);
  });

  test(".agent-scope.yml when the body has none", () => {
    const r = gate({ diff, body: "no scope here", scopeFile: "scope:\n  - docs/**\n", mode: "warn" });
    expect(r.scope.file).toEqual(["docs/**"]);
    expect(r.findings.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(r.summary).toContain("from `.agent-scope.yml` on the base branch");
  });

  test("the PR body cannot widen the file scope", () => {
    expect(outOfScope("scope: src/**, docs/**", "scope:\n  - nothing/**\n")).toEqual(["docs/b.md", "src/a.ts"]);
    expect(outOfScope("scope: '**'", "scope:\n  - src/**\n")).toEqual(["docs/b.md"]);
  });

  test("the PR body can narrow the file scope", () => {
    expect(outOfScope("scope: src/**", "scope:\n  - src/**\n  - docs/**\n")).toEqual(["docs/b.md"]);
    expect(gate({ diff, body: "scope: src/**", scopeFile: "scope: [src/**, docs/**]", mode: "warn" }).summary).toContain(
      "narrows the file scope",
    );
  });

  test("a body pattern outside the file scope matches nothing", () => {
    expect(outOfScope("scope: docs/**", "scope:\n  - src/**\n")).toEqual(["docs/b.md", "src/a.ts"]);
  });

  test("a scope file without patterns is ignored with a note", () => {
    const r = gate({ diff, body: "scope: src/**", scopeFile: "# empty\n", mode: "warn" });
    expect(r.scope).toEqual({ file: null, body: ["src/**"], fileWithoutPatterns: true });
    expect(r.summary).toContain("has no `scope:` patterns and was ignored");
  });

  test("no scope anywhere: no findings and a notice", () => {
    const r = gate({ diff, body: "", scopeFile: null, mode: "block" });
    expect(r.scope).toEqual({ file: null, body: null, fileWithoutPatterns: false });
    expect(r.findings).toEqual([]);
    expect(r.summary).toContain("scope check skipped");
    expect(r.exitCode).toBe(0);
  });
});
