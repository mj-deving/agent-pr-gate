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

describe("parameterised tests", () => {
  const classes = (lines: string[]) => detect(fileDiff("test/add.test.ts", lines)).map((x) => x.class);
  test("rewrite into a one-line it.each is not test-deleted", () => {
    expect(classes(["-it('adds one', () => { expect(add(1)).toBe(2); });", "+it.each([[1, 2]])('adds %i', (a, b) => { expect(add(a)).toBe(b); });"])).toEqual([]);
  });
  test("rewrite into a multi-line it.each table is not test-deleted", () => {
    expect(classes(["-it('adds one', () => {", "-  expect(add(1)).toBe(2);", "-});", "+it.each([", "+  [1, 2],", "+])('adds %i', (a, b) => {", "+  expect(add(a)).toBe(b);", "+});"])).toEqual([]);
  });
  test("rewrite into a test.each tagged template is not test-deleted", () => {
    expect(classes(["-test('adds one', () => {", "-  expect(add(1)).toBe(2);", "-});", "+test.each`", "+  a | b", "+  ${1} | ${2}", "+`('adds $a', ({ a, b }) => {", "+  expect(add(a)).toBe(b);", "+});"])).toEqual([]);
  });
  test("an it.each title with nothing removed is no finding", () => {
    expect(classes(["+it.each([[1, 2]])('adds %i', (a, b) => { expect(add(a)).toBe(b); });"])).toEqual([]);
  });
});

describe("test accounting", () => {
  const py = (lines: string[]) => detect(fileDiff("tests/test_a.py", lines)).map((x) => x.class);
  const js = (lines: string[]) => detect(fileDiff("test/a.test.ts", lines)).map((x) => x.class);
  const twoHunks = (path: string, first: string[], second: string[], context = ["", ""]) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${first.filter((l) => !l.startsWith("+")).length} +1,${first.filter((l) => !l.startsWith("-")).length} @@ ${context[0]}`,
      ...first,
      `@@ -100,${second.filter((l) => !l.startsWith("+")).length} +100,${second.filter((l) => !l.startsWith("-")).length} @@ ${context[1]}`,
      ...second,
      "",
    ].join("\n");

  describe("folding tests into a parameterised test", () => {
    const folded = (rows: string[]) =>
      twoHunks(
        "tests/test_a.py",
        [
          "-def test_parse_int():",
          "-    assert parse('1') == 1",
          "+@pytest.mark.parametrize('text, value', [",
          ...rows,
          "+])",
          "+def test_parse(text, value):",
          "+    assert parse(text) == value",
        ],
        ["-def test_parse_float():", "-    assert parse('1.5') == 1.5", " ", "-def test_parse_neg():", "-    assert parse('-1') == -1"],
      );
    test("three tests folded into three rows is no finding", () => {
      expect(detect(folded(["+    ('1', 1),", "+    ('1.5', 1.5),", "+    pytest.param('-1', -1, id='neg'),"]))).toEqual([]);
    });
    test("three tests folded into two rows leaves one test-deleted", () => {
      expect(detect(folded(["+    ('1', 1),", "+    ('1.5', 1.5),"])).map((x) => x.class)).toEqual(["test-deleted"]);
    });
    test("stacked parametrize decorators multiply", () => {
      const diff = twoHunks(
        "tests/test_a.py",
        ["-def test_a():", "-    run()", "+@pytest.mark.parametrize('x', [1, 2])", "+@pytest.mark.parametrize('y', argvalues=(3, 4))", "+def test_xy(x, y):", "+    run(x, y)"],
        ["-def test_b():", "-    run()", " ", "-def test_c():", "-    run()", " ", "-def test_d():", "-    run()"],
      );
      expect(detect(diff)).toEqual([]);
    });
    test("a parametrize over a name cannot be counted and absorbs nothing extra", () => {
      const diff = twoHunks(
        "tests/test_a.py",
        ["-def test_a():", "-    run()", "+@pytest.mark.parametrize('x', CASES)", "+def test_x(x):", "+    run(x)"],
        ["-def test_b():", "-    run()"],
      );
      expect(detect(diff).map((x) => x.class)).toEqual(["test-deleted"]);
    });
    test("fixture params multiply every test that takes the fixture", () => {
      const diff = twoHunks(
        "tests/test_a.py",
        [
          "+@pytest.fixture(params=['explicit', 'decorator'])",
          "+def mode(request):",
          "+    return request.param",
          " ",
          "-def test_run_explicit():",
          "-    run('explicit')",
          "-def test_run_decorator():",
          "-    run('decorator')",
          "+def test_run(mode):",
          "+    run(mode)",
        ],
        [" # end"],
      );
      expect(detect(diff)).toEqual([]);
    });
    test("rows added to a surviving parametrized test absorb a removed test", () => {
      const diff = twoHunks(
        "tests/test_a.py",
        [" @pytest.mark.parametrize('n', [", "     1,", "+    2,", " ])", " def test_n(n):", "     run(n)"],
        ["-def test_two():", "-    run(2)"],
      );
      expect(detect(diff)).toEqual([]);
    });
    test("test.each over three titles replaces a test and absorbs two more", () => {
      expect(
        js([
          "-test('block', () => {",
          "-  expect(run('block')).toBe(1)",
          "-})",
          "-test('full', () => {",
          "-  expect(run('full')).toBe(1)",
          "-})",
          " ",
          "-test('none', () => {",
          "-  expect(run('none')).toBe(1)",
          "-})",
          "+test.each(['block', 'full', 'none'])(",
          "+  'runs in %s mode',",
          "+  async mode => {",
          "+    expect(run(mode)).toBe(1)",
          "+  },",
          "+)",
        ]),
      ).toEqual([]);
    });
    test("a test.each tagged template counts its rows below the header", () => {
      expect(
        js([
          "-test('one', () => { expect(add(1)).toBe(2) })",
          "-test('two', () => { expect(add(2)).toBe(3) })",
          "+test.each`",
          "+  a    | b",
          "+  ${1} | ${2}",
          "+  ${2} | ${3}",
          "+`('adds $a', ({ a, b }) => {",
          "+  expect(add(a)).toBe(b)",
          "+})",
        ]),
      ).toEqual([]);
    });
  });

  describe("quiet deletions stay findings", () => {
    test("deleting a test while adding an unrelated parameterless test in another hunk", () => {
      const diff = twoHunks("tests/test_a.py", ["-def test_rejects_negative():", "-    assert check(-1) is False"], ["+def test_smoke():", "+    assert check"]);
      expect(detect(diff).map((x) => x.class)).toEqual(["test-deleted"]);
    });
    test("deleting a test in another file does not use this file's parametrized rows", () => {
      const diff =
        fileDiff("tests/test_a.py", ["+@pytest.mark.parametrize('x', [1, 2, 3])", "+def test_x(x):", "+    run(x)"]) +
        fileDiff("tests/test_b.py", ["-def test_y():", "-    run()"]);
      expect(detect(diff).map((x) => `${x.class} ${x.file}`)).toEqual(["test-deleted tests/test_b.py"]);
    });
    test("a regex .test( call is not a test head", () => {
      expect(js(["-  const ok = /x/.test('a')", "+  const ok = true"])).toEqual([]);
      expect(js(["-function test(a) {", "-  return a", "-}"])).toEqual([]);
    });
  });

  describe("assertions belong to their test", () => {
    test("an assertion removed from a kept test is not offset by a new test in the same change block", () => {
      const diff = fileDiff(
        "tests/test_info.py",
        ["     assert eq is False", "-    assert load() == {'a': 1}", "+", "+def test_new(tmp_path):", "+    assert load() == {}"],
        {},
      ).replace("@@ -1,2 +1,4 @@", "@@ -38,2 +38,4 @@ def test_self_heals(tmp_path: Path) -> None:");
      expect(detect(diff).map((x) => x.class)).toEqual(["assert-removed"]);
    });
    test("the same shape in JS: a new it() below does not offset", () => {
      expect(
        js([" it('heals', () => {", "   run()", "-  expect(load()).toEqual({ a: 1 })", " })", "+it('new', () => {", "+  expect(load()).toEqual({})", "+})"]),
      ).toEqual(["assert-removed"]);
    });
    test("assertions rewritten across change blocks of one test are no finding", () => {
      expect(
        py([
          " def test_close():",
          "-    got = []",
          "+    class NS:",
          "+        got = False",
          "     run()",
          "-    assert len(got) == 1",
          "-    assert len(more) == 1",
          "+    assert NS.got",
          "     cleanup()",
          "+    assert NS.more",
        ]),
      ).toEqual([]);
    });
    test("fewer assertions in the same test is the surplus", () => {
      expect(py([" def test_close():", "-    assert a == 1", "     run()", "-    assert b == 2", "+    assert a"])).toEqual(["assert-removed"]);
    });
    test("assertions folded into new parametrize rows of the same test", () => {
      const lines = (rows: string[]) => [
        "+@pytest.mark.parametrize('x, y', [",
        ...rows,
        "+])",
        "-def test_add():",
        "+def test_add(x, y):",
        "-    assert add(1) == 2",
        "-    assert add(2) == 3",
        "-    assert add(3) == 4",
        "+    assert add(x) == y",
      ];
      expect(py(lines(["+    (1, 2),", "+    (2, 3),", "+    (3, 4),"]))).toEqual([]);
      expect(py(lines(["+    (1, 2),", "+    (2, 3),"]))).toEqual(["assert-removed"]);
    });
    test("a renamed test keeps its assertions on the books", () => {
      expect(py(["-def test_old():", "+def test_new():", "     x = run()", "-    assert x == 1", "-    assert y == 2", "+    assert x == 1.0"])).toEqual(["assert-removed"]);
    });
    test("assertions of a deleted test are reported once, as the deleted test", () => {
      expect(py(["-def test_gone():", "-    assert a == 1", "-    assert b == 2"])).toEqual(["test-deleted"]);
    });
    test("the hunk header names the owning test when the def line is above the hunk", () => {
      const diff = twoHunks(
        "tests/test_a.py",
        ["-    assert a == 1", "     run()"],
        ["     run()", "+    assert a == 1.0"],
        ["def test_one():", "def test_one():"],
      );
      expect(detect(diff)).toEqual([]);
      const other = twoHunks("tests/test_a.py", ["-    assert a == 1", "     run()"], ["     run()", "+    assert a == 1.0"], ["def test_one():", "def test_two():"]);
      expect(detect(other).map((x) => x.class)).toEqual(["assert-removed"]);
    });
  });

  describe("test heads", () => {
    test("a title on the line after test( is read, so a retitle in place is a rename", () => {
      expect(js(["-test(", "-  'old title',", "+test(", "+  'new title',", "   () => {", "     expect(run()).toBe(1)", "   },", " )"])).toEqual([]);
    });
    test("test.describe and test.beforeEach are not tests", () => {
      expect(js(["-test.describe('suite', () => {", "+describe('suite', () => {", "-test.beforeEach(() => {})"])).toEqual([]);
    });
  });
});
