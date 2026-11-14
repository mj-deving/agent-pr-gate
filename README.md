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
| `assert-removed` | assertions removed from a test that the same test does not make up for (rewrites, moves and folds into parameter rows do not count) |
| `test-deleted` | a test case or test file removed; renames, moves and folds into a parameterised test with enough rows do not count |
| `threshold-lowered` | coverage minimums lowered or lint maximums raised in `package.json`, jest/vitest config, `pyproject.toml`, `.coveragerc`, `setup.cfg` |
| `out-of-scope` | changed file outside the declared scope |

Mentions inside strings and ordinary comments are not findings. Raising a threshold is not a finding.

## Results

The benchmark lives in [`bench/`](bench/): 170 real commit diffs from 50 public MIT, Apache-2.0 and BSD repositories, in four sets. Clean diffs are left as upstream wrote them; planted diffs carry exactly one injected defect. Every set was built by a separate AI agent that never saw the detector code, and each held-out set was committed before the detector first ran on it. Run it with `bun bench/run.ts --set dev|heldout|heldout2|heldout3|all`.

Detector 0.4.0, dataset b7feccc36acb ([results/](results/)).

| set | role | cases | defects found (planted + real) | clean diffs flagged | precision |
|---|---|---|---|---|---|
| heldout3 | **test set**, measured once | 56 | 26/27 | 1/29 | 81.3 % |
| heldout2 | tuning (consumed) | 44 | 27/27 | 0/17 | 100 % |
| heldout | tuning (consumed) | 20 | 15/15 | 0/5 | 100 % |
| dev | tuning | 50 | 31/31 | 0/19 | 96.9 % |

**The number to trust is heldout3.** Its clean diffs were chosen by a mechanical rule (the newest commits that touch a test file, taken in order), not hand-picked, so its false-alarm rate is closest to what a real repository sees. It also contains four upstream commits that genuinely add a suppression or skip.

| class (heldout3) | found | false alarms |
|---|---|---|
| `skip` | 5/5 | 0 |
| `only` | 3/3 | 0 |
| `type-suppress` | 3/3 | 0 |
| `lint-suppress` | 6/6 | 4 |
| `assert-removed` | 3/4 | 2 |
| `test-deleted` | 3/3 | 0 |
| `threshold-lowered` | 3/3 | 0 |

**What went wrong on the way, and stayed in the record.**

- Detector 0.1.0 missed most removed assertions: it forgave a removal whenever any new assertion appeared in the same file. Review caught it.
- The first held-out set (5 clean diffs) was too small. After it showed one false alarm, it was inspected, so it no longer counts as held out.
- On heldout2, detector 0.3.0 flagged several clean diffs (no result file kept): real refactors (several Python tests folded into one `parametrize`, tests moved or restructured) read as deleted tests. That set had a bias of its own, as its clean cases were picked to favour refactors.
- Detector 0.4.0 redesigned `test-deleted` and `assert-removed` as test accounting (parameter rows, folds, assertion ownership), tuned on dev, heldout and heldout2, then ran once on heldout3.

**Remaining false alarms on heldout3.** `h3-clean-24` adds `# pragma: no cover`: the gate counts coverage exclusions as `lint-suppress` by design (same as `skip-06` in dev). The other false alarms sit in rows that already carry a defect: a second `eslint-disable` beyond the labelled one, an `oxlint-disable` added by the upstream commit itself, and two rewritten assertions in an upstream refactor. One planted assertion removal was missed (`h3-assertrm-04`).

## What the gate does not catch

- **Weakened assertions.** `expect(x).toBe(3)` becoming `expect(x).toBeDefined()` keeps an assertion in place.
- **Rules switched off in config.** `"no-explicit-any": "off"` in an eslint config, codecov `target:`, eslint `complexity: ["error", N]`.
- **Test files outside the naming conventions**, for example `e2e/login.ts` without `.test`, `.spec` or a `tests/` directory.
- **Intent.** The gate sees the diff, not whether the change was right. It narrows what a reviewer has to check; it does not replace the review.
- **Folds are credited by row count, not by content.** A removed test is absorbed by any parameterised test in the same file that has spare rows (`parametrize` lists, fixture `params=`, `it.each`/`test.each` tables). Deleting one test while adding an unrelated parameterised test with enough rows passes.
- **Parameter rows the gate cannot count.** A `parametrize` or `.each` over a variable or comprehension counts as one row, `describe.each` and class-level `parametrize`/`pytestmark` are not counted, so a fold into those still reads as a deletion. Rows removed from an existing parameter list are not reported.
- **Assertions moved between tests.** An assertion moved to another test with edits reads as removed; an identical one does not. Ownership comes from indentation inside the hunk and git's hunk header, so a hunk that starts deep inside a long test can attribute lines to the wrong test.
- **Test files in other languages.** Only TS/JS and Python test files are accounted; deleting, say, a Go or Ruby test file is not reported.
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
