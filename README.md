# agent-pr-gate

**A GitHub Action that catches the shortcuts coding agents take to get CI green: skipped tests, silenced type and lint checks, deleted assertions, lowered coverage thresholds, and changes outside the task.**

Agents are good at making checks pass. Sometimes they do it by lowering the bar instead of fixing the code. The diff is small, CI is green, and a human reviewer misses it. This action reads the pull request diff and reports every place where the bar went down, with file, line and class, before a human reviews.

It is deterministic: no LLM, no API key, no network beyond the GitHub API. The [benchmark](#results) below measures how often it finds planted defects and how often it raises a false alarm.

## Usage

```yaml
on: pull_request
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: mj-deving/agent-pr-gate@v0
        with:
          mode: block # or warn (default)
```

Findings appear as a table in the job summary and as inline annotations. In `block` mode the job fails on any finding without a justified exception.

**Justified exceptions.** Put `gate-allow: <reason>` in a comment on the same line or the line above. The finding is then listed as an exception with its reason instead of failing the job. An empty reason does not count. The exception stays visible in the diff, where the reviewer reads it.

**Scope.** Declare what the PR may touch with a `scope:` list of globs in the PR body, or in `.agent-scope.yml` on the base branch. Every changed file outside it is reported as `out-of-scope`. The file is read from the base commit, so a PR cannot widen its own scope. A scope in the PR body is the author's declared intent, not a guard: if an agent writes the body, it also writes the scope.

```
scope:
  - src/parser/**
  - test/parser/**
```

## Defect classes

| class | what counts (TS/JS and Python) |
|---|---|
| `skip` | added `it.skip`, `describe.skip`, `xit`, `test.fixme`, `skipIf`, `@pytest.mark.skip`/`skipif`/`xfail`, `unittest.skip` |
| `only` | added `.only`, `fit`, `fdescribe` |
| `type-suppress` | added `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `# type: ignore` |
| `lint-suppress` | added `eslint-disable*`, `biome-ignore`, `# noqa`, `pylint: disable`, coverage and security exclusions (`istanbul ignore`, `pragma: no cover`, `nosec`) |
| `assert-removed` | assertion lines removed from a test file without a replacement |
| `test-deleted` | a test case or test file removed; renames and moves do not count |
| `threshold-lowered` | coverage minimums lowered or lint maximums raised in `package.json`, jest/vitest config, `pyproject.toml`, `.coveragerc`, `setup.cfg` |
| `out-of-scope` | changed file outside the declared scope |

Mentions inside strings and ordinary comments are not findings. Raising a threshold is not a finding.

## Results

The benchmark lives in [`bench/`](bench/): 70 real commit diffs from 22 public MIT, Apache-2.0 and BSD repositories. 24 diffs are left clean, including tricky ones (renamed tests, raised thresholds, "skip" in test titles, rewritten assertions). 46 diffs carry exactly one planted defect. 20 cases are a held-out set, fixed before any tuning of the detector. The dataset was built by a separate agent that never saw the detector code. Run it with `bun bench/run.ts --set all|dev|heldout`.

Detector 0.2.3, dataset 92c7e936958a ([results/](results/)).

| set | cases | recall | precision | clean diffs flagged |
|---|---|---|---|---|
| dev | 50 | 100 % | 96.9 % | 0/19 |
| held-out | 20 | 100 % | 93.8 % | 1/5 |
| all | 70 | 100 % | 95.8 % | 1/24 |

| class | found (all) | false alarms (all) | found (held-out) |
|---|---|---|---|
| `skip` | 8/8 | 0 | 3/3 |
| `only` | 6/6 | 0 | 2/2 |
| `type-suppress` | 7/7 | 0 | 2/2 |
| `lint-suppress` | 7/7 | 1 | 2/2 |
| `assert-removed` | 6/6 | 0 | 2/2 |
| `test-deleted` | 6/6 | 1 | 2/2 |
| `threshold-lowered` | 6/6 | 0 | 2/2 |

**False alarms.** `skip-06`: an upstream commit added `pass  # pragma: no cover`; the gate counts coverage exclusions as `lint-suppress` by design, the dataset labels the line clean. `clean-08` (held-out): a test is rewritten into `it.each([...])(...)`, a form the gate does not recognise as a test definition, so the old test reads as deleted. Both stay counted; the held-out case is not tuned away.

**Read these numbers with care.** The first version (detector 0.1.0) missed most removed assertions, because it forgave a removal whenever any new assertion appeared in the same file. A review caught it; the fix was tuned on the dev set only, and the held-out set was committed before that fix. A later review fix (deleted tests offset only by a test added in the same change block) introduced the clean-08 false alarm on held-out, which is reported rather than tuned. Held-out is 20 cases: no misses on 15 planted defects, one false alarm on 5 clean diffs. The dataset and the detector were written by separate AI agents of the same model family, neither with access to the other's work.

## What the gate does not catch

- **Weakened assertions.** `expect(x).toBe(3)` becoming `expect(x).toBeDefined()` keeps an assertion in place.
- **Rules switched off in config.** `"no-explicit-any": "off"` in an eslint config, codecov `target:`, eslint `complexity: ["error", N]`.
- **Test files outside the naming conventions**, for example `e2e/login.ts` without `.test`, `.spec` or a `tests/` directory.
- **Intent.** The gate sees the diff, not whether the change was right. It narrows what a reviewer has to check; it does not replace the review.
- **Parameterised tests.** A test rewritten into `it.each([...])(...)` or `test.each` reads as a deleted test.
- **File-level exceptions.** A deleted test file or an out-of-scope file cannot carry a `gate-allow` comment.

## Development

```sh
bun install
bun run check   # typecheck + unit tests, offline
bun run build   # bundles src/action.ts to dist/index.mjs
bun bench/validate.ts && bun bench/run.ts --set all
```

## License

Apache-2.0
