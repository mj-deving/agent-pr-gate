import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotations, gate, parseMode, run } from "../src/action.ts";
import { added } from "./helpers.ts";

const skipped = added("test/a.test.ts", "it.skip('x', () => {});");
const allowedSkip = added("test/a.test.ts", "// gate-allow: quarantined until #9", "it.skip('x', () => {});");

describe("gate exit codes", () => {
  test.each([
    ["warn", skipped, 0],
    ["block", skipped, 1],
    ["block", allowedSkip, 0],
    ["block", added("src/a.ts", "export const a = 1;"), 0],
    ["warn", "", 0],
  ] as const)("%s mode -> exit %d", (mode, diff, code) => {
    expect(gate({ diff, body: "", scopeFile: null, mode }).exitCode).toBe(code);
  });

  test("out-of-scope findings block too", () => {
    const r = gate({ diff: added("infra/x.tf", "a"), body: "scope: src/**", scopeFile: null, mode: "block" });
    expect(r.exitCode).toBe(1);
  });
});

describe("summary", () => {
  test("lists findings, allowed exceptions and the result", () => {
    const diff = skipped.replaceAll("test/a.test.ts", "test/b.test.ts") + allowedSkip;
    const { summary } = gate({ diff, body: "", scopeFile: null, mode: "block" });
    expect(summary).toContain("| Class | File | Line | Code | Status |");
    expect(summary).toContain("| skip | <code>test/a.test.ts</code> | 2 | <code>it.skip('x', () =&gt; {});</code> | allowed: quarantined until #9 |");
    expect(summary).toContain("| skip | <code>test/b.test.ts</code> | 1 | <code>it.skip('x', () =&gt; {});</code> | **blocking** |");
    expect(summary).toContain("**Result:** blocked, 1 unallowed finding.");
  });

  test("escapes table-breaking characters", () => {
    const { summary } = gate({ diff: added("src/a.ts", "a || b; // @ts-ignore"), body: "", scopeFile: null, mode: "warn" });
    expect(summary).toContain("<code>a &#124;&#124; b; // @ts-ignore</code>");
    expect(summary).toContain("**Result:** passed in warn mode with 1 unallowed finding.");
  });
});

test("parseMode accepts warn/block and defaults to warn", () => {
  expect(parseMode(undefined)).toBe("warn");
  expect(parseMode("")).toBe("warn");
  expect(parseMode(" Block ")).toBe("block");
  expect(() => parseMode("strict")).toThrow('input "mode" must be "warn" or "block"');
});

test("annotations escape workflow-command syntax and skip allowed findings", () => {
  const findings = gate({ diff: skipped + allowedSkip.replace(/test\/a/g, "test/c"), body: "", scopeFile: null, mode: "block" }).findings;
  expect(annotations(findings, "block")).toEqual([
    "::error file=test/a.test.ts,line=1,title=agent-pr-gate%3A skip::it.skip('x', () => {});",
  ]);
});

describe("run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-pr-gate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function env(body: string, mode: string) {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, body, base: { sha: "abc123" } } }));
    return {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/repo",
      GITHUB_API_URL: "https://api.example.test",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      INPUT_MODE: mode,
      INPUT_TOKEN: "test-token",
    };
  }

  function fakeFetch(routes: Record<string, Response>) {
    const calls: { url: string; accept: string; auth: string }[] = [];
    const impl = async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, accept: headers.Accept!, auth: headers.Authorization! });
      return routes[url] ?? new Response("not found", { status: 404 });
    };
    return { impl, calls };
  }

  test("reads the diff and the base-branch scope file, writes the summary, returns the exit code", async () => {
    const { impl, calls } = fakeFetch({
      "https://api.example.test/repos/octo/repo/pulls/7": new Response(skipped + added("infra/x.tf", "a")),
      "https://api.example.test/repos/octo/repo/contents/.agent-scope.yml?ref=abc123": new Response("scope:\n  - test/**\n"),
    });
    const logs: string[] = [];
    const code = await run(env("no scope in body", "block"), impl, (l) => logs.push(l));

    expect(code).toBe(1);
    expect(calls).toEqual([
      { url: "https://api.example.test/repos/octo/repo/pulls/7", accept: "application/vnd.github.v3.diff", auth: "Bearer test-token" },
      {
        url: "https://api.example.test/repos/octo/repo/contents/.agent-scope.yml?ref=abc123",
        accept: "application/vnd.github.raw",
        auth: "Bearer test-token",
      },
    ]);
    const summary = readFileSync(join(dir, "summary.md"), "utf8");
    expect(summary).toContain("`.agent-scope.yml` on the base branch");
    expect(summary).toContain("| out-of-scope | <code>infra/x.tf</code> | file |");
    expect(logs).toHaveLength(2); // one annotation per unallowed finding
  });

  test("fetches the base scope file even when the body declares a scope, and the file still applies", async () => {
    const { impl, calls } = fakeFetch({
      "https://api.example.test/repos/octo/repo/pulls/7": new Response(skipped + added("infra/x.tf", "a")),
      "https://api.example.test/repos/octo/repo/contents/.agent-scope.yml?ref=abc123": new Response("scope:\n  - test/**\n"),
    });
    // The agent-written body tries to widen the scope to everything; the base file still rules.
    expect(await run(env("scope: '**'", "warn"), impl, () => {})).toBe(0);
    expect(calls.map((c) => c.url)).toContain("https://api.example.test/repos/octo/repo/contents/.agent-scope.yml?ref=abc123");
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("| out-of-scope | <code>infra/x.tf</code> | file |");
  });

  test("a missing scope file is not an error", async () => {
    const { impl } = fakeFetch({ "https://api.example.test/repos/octo/repo/pulls/7": new Response(skipped) });
    expect(await run(env("", "warn"), impl, () => {})).toBe(0);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("scope check skipped");
  });

  test("API failures throw with the status", async () => {
    const { impl } = fakeFetch({
      "https://api.example.test/repos/octo/repo/pulls/7": new Response("diff too large", { status: 406 }),
    });
    await expect(run(env("", "warn"), impl, () => {})).rejects.toThrow("HTTP 406 diff too large");
  });

  test("non-pull_request events are skipped with a notice", async () => {
    const logs: string[] = [];
    expect(await run({ GITHUB_EVENT_NAME: "push" }, fetch, (l) => logs.push(l))).toBe(0);
    expect(logs[0]).toContain("skipped");
  });

  test("a missing token fails loudly", async () => {
    const e = { ...env("", "warn"), INPUT_TOKEN: "" };
    await expect(run(e, fetch, () => {})).rejects.toThrow("no token");
  });
});
