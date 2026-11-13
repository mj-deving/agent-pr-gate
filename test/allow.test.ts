import { describe, expect, test } from "bun:test";
import { detect } from "../src/detect.ts";
import { added, fileDiff } from "./helpers.ts";

const allowedOf = (diff: string) => detect(diff).map((f) => f.allowed);

describe("gate-allow", () => {
  test("on the same line suppresses with the reason recorded", () => {
    const diff = added("src/a.ts", "// @ts-expect-error upstream types are wrong gate-allow: fixed in lib 2.0, see issue 12");
    expect(detect(diff)).toEqual([
      {
        file: "src/a.ts",
        line: 1,
        side: "new",
        class: "type-suppress",
        text: "// @ts-expect-error upstream types are wrong gate-allow: fixed in lib 2.0, see issue 12",
        allowed: "fixed in lib 2.0, see issue 12",
      },
    ]);
  });

  test("on the line directly above suppresses", () => {
    expect(allowedOf(added("test/a.test.ts", "// gate-allow: flaky on CI runners, tracked in #40", "it.skip('x', () => {});"))).toEqual([
      "flaky on CI runners, tracked in #40",
    ]);
  });

  test("an existing allow in context above an added line also counts", () => {
    const diff = fileDiff("test/a.test.ts", [" // gate-allow: vendor bug", "+it.skip('x', () => {});"]);
    expect(allowedOf(diff)).toEqual(["vendor bug"]);
  });

  test.each([
    ["empty reason", "// gate-allow:"],
    ["whitespace reason", "// gate-allow:    "],
    ["block comment with empty reason", "/* gate-allow: */"],
  ])("%s does not suppress", (_label, allow) => {
    expect(allowedOf(added("test/a.test.ts", allow, "it.skip('x', () => {});"))).toEqual([undefined]);
  });

  test("two lines above does not suppress", () => {
    expect(allowedOf(added("test/a.test.ts", "// gate-allow: reason", "const y = 1;", "it.skip('x', () => {});"))).toEqual([
      undefined,
    ]);
  });

  test("suppresses exactly the covered finding", () => {
    const diff = added("test/a.test.ts", "// gate-allow: quarantined", "it.skip('a', () => {});", "it.skip('b', () => {});");
    expect(detect(diff).map((f) => [f.line, f.allowed])).toEqual([
      [2, "quarantined"],
      [3, undefined],
    ]);
  });

  test("inside a string literal it does not count", () => {
    expect(allowedOf(added("test/a.test.ts", "it.skip('gate-allow: nope', () => {});"))).toEqual([undefined]);
  });

  test("works after another Python directive", () => {
    expect(allowedOf(added("src/a.py", "URL = 'x' * 200  # noqa: E501  # gate-allow: generated constant"))).toEqual([
      "generated constant",
    ]);
  });

  test("covers a removed assertion when added next to the removal", () => {
    const diff = fileDiff("test/a.test.ts", [
      " it('renders', () => {",
      "+  // gate-allow: covered by the snapshot test below",
      "-  expect(html).toContain('<b>');",
      " });",
    ]);
    expect(detect(diff).map((f) => [f.class, f.allowed])).toEqual([["assert-removed", "covered by the snapshot test below"]]);
  });

  test("a pre-existing allow in context does not cover a removal", () => {
    const diff = fileDiff("test/a.test.ts", [" // gate-allow: old reason", "-  expect(html).toContain('<b>');"]);
    expect(allowedOf(diff)).toEqual([undefined]);
  });

  test("covers a lowered threshold in JSON through a comment key", () => {
    const diff = fileDiff("package.json", [
      '+      "//": "gate-allow: legacy module excluded, raised again in #77",',
      '-      "branches": 80,',
      '+      "branches": 70,',
    ]);
    expect(allowedOf(diff)).toEqual(["legacy module excluded, raised again in #77"]);
  });
});
