import { describe, expect, test } from "bun:test";
import { detect, type DefectClass } from "../src/detect.ts";
import { added, fileDiff } from "./helpers.ts";

const classes = (diff: string) => detect(diff).map((f) => f.class);
const only = (diff: string, cls: DefectClass) => detect(diff).filter((f) => f.class === cls);

describe("finding shape", () => {
  test("names file, line, side, class and the triggering line", () => {
    const diff = fileDiff("test/math.test.ts", [" import { add } from './add';", "+it.skip('adds', () => {});"], {
      oldStart: 7,
      newStart: 7,
    });
    expect(detect(diff)).toEqual([
      { file: "test/math.test.ts", line: 8, side: "new", class: "skip", text: "it.skip('adds', () => {});" },
    ]);
  });
});

describe("skip", () => {
  test.each([
    ["test/a.test.ts", "it.skip('x', () => {})"],
    ["test/a.test.ts", "describe.skip('suite', () => {})"],
    ["test/a.test.ts", "test.skip('x', () => {})"],
    ["src/a.spec.js", "  xit('x', () => {})"],
    ["src/a.spec.js", "xdescribe('x', () => {})"],
    ["e2e/login.spec.ts", "test.describe.skip('flow', () => {})"],
    ["test/a.test.ts", "it.skipIf(process.platform === 'win32')('x', () => {})"],
    ["tests/test_a.py", "@pytest.mark.skip(reason='flaky')"],
    ["tests/test_a.py", "@pytest.mark.skipif(sys.platform == 'win32', reason='x')"],
    ["tests/test_a.py", "@pytest.mark.xfail"],
    ["tests/test_a.py", "@unittest.skip('later')"],
    ["tests/test_a.py", "    pytest.skip('not ready')"],
    ["tests/test_a.py", "        self.skipTest('x')"],
  ])("%s: %s", (path, line) => {
    expect(classes(added(path, line))).toEqual(["skip"]);
  });

  test.each([
    ["in a JS string", "test/a.test.ts", "const label = 'it.skip(';"],
    ["in a JS line comment", "test/a.test.ts", "// never use it.skip( here"],
    ["in a JS block comment", "test/a.test.ts", "/* describe.skip is banned */ run();"],
    ["in a Python string", "tests/test_a.py", 'msg = "@pytest.mark.skip"'],
    ["in a Python comment", "tests/test_a.py", "x = 1  # pytest.mark.skip later"],
    ["in a non-code file", "README.md", "Use `it.skip(` sparingly."],
    ["xit outside a test file", "src/x.ts", "xit(value)"],
  ])("not when %s", (_label, path, line) => {
    expect(detect(added(path, line))).toEqual([]);
  });

  test("not inside a multi-line JS template literal", () => {
    const diff = added("test/a.test.ts", "const doc = `", "it.skip('x')", "`;");
    expect(detect(diff)).toEqual([]);
  });

  test("not inside a multi-line Python docstring", () => {
    const diff = added("tests/test_a.py", 'def helper():', '    """Example:', "    @pytest.mark.skip", '    """');
    expect(detect(diff)).toEqual([]);
  });

  test("removing a skip is not a finding", () => {
    const diff = fileDiff("test/a.test.ts", ["-it.skip('x', () => {})", "+it('x', () => {})"]);
    expect(detect(diff)).toEqual([]);
  });

  test("a pre-existing skip in context is not a finding", () => {
    expect(detect(fileDiff("test/a.test.ts", [" it.skip('x', () => {})", "+const y = 1;"]))).toEqual([]);
  });
});

describe("only", () => {
  test.each([
    ["test/a.test.ts", "it.only('x', () => {})"],
    ["test/a.test.ts", "describe.only('x', () => {})"],
    ["test/a.test.ts", "test.only('x', () => {})"],
    ["src/a.spec.js", "fit('x', () => {})"],
    ["src/a.spec.js", "fdescribe('x', () => {})"],
  ])("%s: %s", (path, line) => {
    expect(classes(added(path, line))).toEqual(["only"]);
  });

  test.each([
    ["in a string", "test/a.test.ts", 'const s = "it.only(";'],
    ["as a method call", "test/a.test.ts", "map.fit(bounds);"],
    ["fit() outside a test file", "src/layout.ts", "fit(box);"],
  ])("not %s", (_label, path, line) => {
    expect(detect(added(path, line))).toEqual([]);
  });
});

describe("type-suppress", () => {
  test.each([
    ["src/a.ts", "// @ts-ignore"],
    ["src/a.ts", "  // @ts-expect-error wrong upstream types"],
    ["src/a.ts", "// @ts-nocheck"],
    ["src/a.tsx", "{/* @ts-ignore */}"],
    ["src/a.py", "x = f()  # type: ignore[attr-defined]"],
    ["src/a.py", "x = f()  # pyright: ignore"],
  ])("%s: %s", (path, line) => {
    expect(classes(added(path, line))).toEqual(["type-suppress"]);
  });

  test.each([
    ["src/a.ts", "// do not use @ts-ignore in new code"],
    ["src/a.ts", 'const s = "// @ts-ignore";'],
    ["src/a.py", "x = 1  # type: int"],
    ["src/a.py", 'x = "# type: ignore"'],
  ])("not %s: %s", (path, line) => {
    expect(detect(added(path, line))).toEqual([]);
  });
});

describe("lint-suppress", () => {
  test.each([
    ["src/a.ts", "// eslint-disable-next-line no-console"],
    ["src/a.ts", "/* eslint-disable */"],
    ["src/a.ts", "console.log(x); // eslint-disable-line"],
    ["src/a.ts", "// biome-ignore lint/style/noVar: legacy"],
    ["src/a.py", "URL = 'x' * 200  # noqa: E501"],
    ["src/a.py", "def f(a, b, c, d, e, f):  # pylint: disable=too-many-arguments"],
    ["src/a.py", "# ruff: noqa"],
  ])("%s: %s", (path, line) => {
    expect(classes(added(path, line))).toEqual(["lint-suppress"]);
  });

  test("type and lint directives on one line give two findings", () => {
    expect(classes(added("src/a.py", "x = f()  # type: ignore  # noqa: E501")).sort()).toEqual([
      "lint-suppress",
      "type-suppress",
    ]);
  });

  test.each([
    ["src/a.ts", "// we removed the eslint-disable here"],
    ["src/a.py", 'pattern = "# noqa"'],
    ["src/a.py", "# see the noqa docs before adding one"],
  ])("not %s: %s", (path, line) => {
    expect(detect(added(path, line))).toEqual([]);
  });
});

describe("newly created files", () => {
  test("suppressions in a new file are detected", () => {
    const diff = fileDiff("src/new.ts", ["+// @ts-nocheck", "+export const x: number = 'a';"], { status: "added" });
    expect(detect(diff)).toEqual([{ file: "src/new.ts", line: 1, side: "new", class: "type-suppress", text: "// @ts-nocheck" }]);
  });

  test("a focused test in a new test file is detected", () => {
    const diff = fileDiff("tests/new.test.ts", ["+describe('x', () => {", "+  it.only('y', () => {});", "+});"], {
      status: "added",
    });
    expect(classes(diff)).toEqual(["only"]);
  });
});

describe("assert-removed", () => {
  test("a removed expect() is reported on the old side", () => {
    const diff = fileDiff("test/a.test.ts", [" it('adds', () => {", "-  expect(add(1, 2)).toBe(3);", " });"], {
      oldStart: 4,
      newStart: 4,
    });
    expect(detect(diff)).toEqual([
      { file: "test/a.test.ts", line: 5, side: "old", class: "assert-removed", text: "expect(add(1, 2)).toBe(3);" },
    ]);
  });

  test.each([
    ["tests/test_a.py", "    assert add(1, 2) == 3"],
    ["tests/test_a.py", "        self.assertEqual(add(1, 2), 3)"],
    ["test/a.test.js", "  assert.strictEqual(add(1, 2), 3);"],
    ["test/a.test.js", "  result.should.equal(3);"],
  ])("%s: %s", (path, line) => {
    expect(classes(fileDiff(path, [`-${line}`]))).toEqual(["assert-removed"]);
  });

  test("an assertion moved within the file is not a finding", () => {
    const diff = fileDiff("test/a.test.ts", ["-  expect(x).toBe(1);", " other();", "+    expect(x).toBe(1);"]);
    expect(detect(diff)).toEqual([]);
  });

  test("an edited assertion is not a finding", () => {
    const diff = fileDiff("test/a.test.ts", ["-  expect(add(1, 2)).toBe(3);", "+  expect(add(1, 2)).toEqual(3);"]);
    expect(detect(diff)).toEqual([]);
  });

  test("only the surplus of removed over added assertions is reported", () => {
    const diff = fileDiff("test/a.test.ts", ["-  expect(a).toBe(1);", "-  expect(b).toBe(2);", "+  expect(a).toBe(10);"]);
    expect(classes(diff)).toEqual(["assert-removed"]);
  });

  test("an assertion moved to another test file is not a finding", () => {
    const diff =
      fileDiff("tests/test_utils.py", ["-def check():", '-    assert "Authorization" in headers']) +
      fileDiff("tests/test_auth.py", ["+def check():", '+    assert "Authorization"  in headers']);
    expect(only(diff, "assert-removed")).toEqual([]);
  });

  test("a new test appended further down the same hunk does not offset a removed assertion", () => {
    const diff = fileDiff("test/a.test.ts", [
      " it('min max', () => {",
      "-  expect(schema.maxValue).toEqual(1);",
      " });",
      " ",
      "+it('new behaviour', () => {",
      "+  expect(other.minValue).toEqual(0);",
      "+});",
    ]);
    expect(detect(diff)).toEqual([
      { file: "test/a.test.ts", line: 2, side: "old", class: "assert-removed", text: "expect(schema.maxValue).toEqual(1);" },
    ]);
  });

  test("an unrelated assertion added in another hunk of the file does not offset a removal", () => {
    const diff = [
      "diff --git a/tests/test_a.py b/tests/test_a.py",
      "--- a/tests/test_a.py",
      "+++ b/tests/test_a.py",
      "@@ -1,2 +1,1 @@",
      " def test_a():",
      "-    assert str(u) == 'x'",
      "@@ -40,1 +39,2 @@",
      " def test_b():",
      "+    assert other() == 2",
      "",
    ].join("\n");
    expect(classes(diff)).toEqual(["assert-removed"]);
  });

  test("a rewrite pairs 1:1 within its change block", () => {
    const diff = fileDiff("tests/test_a.py", ["-    assert a == 1", "-    assert b == 2", "+    assert a == 1.0", " ", "+    assert c == 3"]);
    expect(only(diff, "assert-removed").map((f) => f.text)).toEqual(["assert b == 2"]);
  });

  test("a removed assertion in a comment or outside test files is not a finding", () => {
    expect(detect(fileDiff("test/a.test.ts", ["-  // expect(x).toBe(1);"]))).toEqual([]);
    expect(detect(fileDiff("src/a.py", ["-    assert x > 0"]))).toEqual([]);
  });
});

describe("test-deleted", () => {
  test("a deleted test file is one whole-file finding", () => {
    const diff = fileDiff("test/a.test.ts", ["-it('adds', () => {", "-  expect(add(1, 2)).toBe(3);", "-});"], {
      status: "deleted",
    });
    expect(detect(diff)).toEqual([
      { file: "test/a.test.ts", line: 0, side: "old", class: "test-deleted", text: "deleted test file (1 of 1 tests not re-added)" },
    ]);
  });

  test("a renamed (moved) test file is not a finding", () => {
    expect(detect(fileDiff("tests/unit/a.test.ts", [], { renamedFrom: "test/a.test.ts" }))).toEqual([]);
  });

  test("delete plus re-add of the same tests elsewhere is a move, not a deletion", () => {
    const diff =
      fileDiff("test/a.test.ts", ["-it('adds', () => {", "-  expect(add(1, 2)).toBe(3);", "-});"], { status: "deleted" }) +
      fileDiff("test/math/add.test.ts", ["+it('adds', () => {", "+  expect(add(1, 2)).toBe(3);", "+});"], {
        status: "added",
      });
    expect(detect(diff)).toEqual([]);
  });

  test("a removed it() block is reported", () => {
    const diff = fileDiff("test/a.test.ts", [" it('keeps', () => {});", "-it('adds', () => {", "-  run();", "-});"]);
    expect(only(diff, "test-deleted")).toEqual([
      { file: "test/a.test.ts", line: 2, side: "old", class: "test-deleted", text: "it('adds', () => {" },
    ]);
  });

  test("renaming a test title is not a finding", () => {
    const diff = fileDiff("test/a.test.ts", ["-it('adds', () => {", "+it('adds two numbers', () => {", "   run();", " });"]);
    expect(detect(diff)).toEqual([]);
  });

  test("a removed Python test function is reported, a renamed one is not", () => {
    expect(classes(fileDiff("tests/test_a.py", ["-def test_add():", "-    run()"]))).toEqual(["test-deleted"]);
    expect(detect(fileDiff("tests/test_a.py", ["-def test_add():", "+def test_add_numbers():", "     run()"]))).toEqual([]);
  });

  test("turning a test into it.skip is a skip, not a deletion", () => {
    expect(classes(fileDiff("test/a.test.ts", ["-it('adds', () => {", "+it.skip('adds', () => {"]))).toEqual(["skip"]);
  });
});

describe("threshold-lowered", () => {
  test("lowered jest coverage threshold in package.json", () => {
    const diff = fileDiff("package.json", ['     "global": {', '-      "branches": 80,', '+      "branches": 60,', '       "lines": 90'], {
      oldStart: 20,
      newStart: 20,
    });
    expect(detect(diff)).toEqual([
      { file: "package.json", line: 21, side: "new", class: "threshold-lowered", text: '"branches": 60,' },
    ]);
  });

  test.each([
    ["pyproject.toml", "fail_under = 90", "fail_under = 80"],
    [".coveragerc", "fail_under = 90", "fail_under = 85.5"],
    ["setup.cfg", "addopts = --cov=pkg --cov-fail-under=80", "addopts = --cov=pkg --cov-fail-under=70"],
    ["vitest.config.ts", "      thresholds: { lines: 90, branches: 80 },", "      thresholds: { lines: 85, branches: 80 },"],
    ["jest.config.js", "    global: { statements: 95 },", "    global: { statements: 50 },"],
    [".github/workflows/ci.yml", "        run: pytest --cov-fail-under 80", "        run: pytest --cov-fail-under 60"],
    ["package.json", '    "lint": "eslint . --max-warnings 0",', '    "lint": "eslint . --max-warnings 25",'],
    ["setup.cfg", "max-complexity = 10", "max-complexity = 18"],
  ])("%s: %s -> %s", (path, before, after) => {
    expect(classes(fileDiff(path, [`-${before}`, `+${after}`]))).toEqual(["threshold-lowered"]);
  });

  test.each([
    ["package.json", '"branches": 80,', '"branches": 90,'],
    ["pyproject.toml", "fail_under = 80", "fail_under = 80"],
    ["package.json", '"lint": "eslint . --max-warnings 10",', '"lint": "eslint . --max-warnings 0",'],
  ])("raising %s: %s -> %s is not a finding", (path, before, after) => {
    expect(detect(fileDiff(path, [`-${before}`, `+${after}`]))).toEqual([]);
  });

  test("removing a threshold is reported on the old side", () => {
    const diff = fileDiff("pyproject.toml", [" [tool.coverage.report]", "-fail_under = 90", " show_missing = true"]);
    expect(detect(diff)).toEqual([
      { file: "pyproject.toml", line: 2, side: "old", class: "threshold-lowered", text: "fail_under = 90" },
    ]);
  });

  test("a new threshold is not a finding", () => {
    expect(detect(fileDiff("pyproject.toml", ["+fail_under = 50"]))).toEqual([]);
  });

  test("threshold-looking numbers outside config files or in comments are ignored", () => {
    expect(detect(fileDiff("docs/coverage.md", ["-lines: 90", "+lines: 50"]))).toEqual([]);
    expect(detect(fileDiff("pyproject.toml", ["-# fail_under = 90", "+# fail_under = 50"]))).toEqual([]);
  });
});

describe("test file renamed out of the test convention", () => {
  test("spec renamed to .bak is test-deleted", () => {
    const found = detect(fileDiff("src/a.spec.ts.bak", [], { renamedFrom: "src/a.spec.ts" }));
    expect(found.map((x) => x.class)).toEqual(["test-deleted"]);
    expect(found[0]!.text).toContain("src/a.spec.ts");
  });
  test("moved out of __tests__ into src is test-deleted", () => {
    expect(detect(fileDiff("src/foo.ts", [], { renamedFrom: "src/__tests__/foo.ts" })).map((x) => x.class)).toEqual(["test-deleted"]);
  });
  test("rename that stays a test file is no finding", () => {
    expect(detect(fileDiff("tests/unit/a.test.ts", [], { renamedFrom: "test/a.test.ts" }))).toEqual([]);
  });
});

describe("test-deleted locality", () => {
  const diff = [
    "diff --git a/test/x.test.ts b/test/x.test.ts",
    "--- a/test/x.test.ts",
    "+++ b/test/x.test.ts",
    "@@ -1,3 +1,2 @@",
    " import { x } from \"./x\";",
    "-it(\"rejects invalid input\", () => { expect(x(-1)).toBe(false); });",
    " // keep",
    "@@ -40,2 +39,3 @@",
    " // end",
    "+it(\"smoke\", () => { expect(x).toBeDefined(); });",
    " // eof",
    "",
  ].join("\n");
  test("deleting a test and adding an unrelated one elsewhere is test-deleted", () => {
    expect(detect(diff).map((f) => f.class)).toContain("test-deleted");
  });
});
