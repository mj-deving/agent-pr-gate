# agent-pr-gate benchmark

**Provenance.** This paragraph describes the original 70 cases (sets `dev` and `heldout`); the second held-out set `heldout2` is described under "Held-out split 2" below. The cases are unified diffs taken from real public commits of 22 GitHub repositories under MIT, Apache-2.0 or BSD-3-Clause licenses (TypeScript/JavaScript and Python), fetched read-only with `gh api repos/<owner>/<repo>/commits/<sha> -H "Accept: application/vnd.github.diff"`. The dataset was built independently of any detector implementation. Clean cases (24) are real diffs left byte-for-byte as upstream wrote them, apart from a few that were trimmed to a subset of their files; they were screened so that they contain none of the target defects, and they include deliberately tricky ones (raised coverage thresholds, renamed or moved test files, the word "skip" in test titles and identifiers, assertions removed and rewritten one-to-one). Planted cases (46) start from a different real diff each and receive exactly one injected defect of the kind a coding agent would produce: `.skip`/`xit`/`@pytest.mark.skip|skipif|xfail`/`@unittest.skip` on a newly added test, `.only`/`fit`/`fdescribe` left on a new test, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`/`# type: ignore` on an added line, `eslint-disable*`/`biome-ignore`/`# noqa`/`# pylint: disable`, an existing assertion line turned into a removed line, a test case or whole test file deleted (cut from the file as it exists at the base commit), or a coverage threshold lowered in `vitest.config.ts`, `package.json` or `pyproject.toml` (edited against the config file as it exists at the base commit, appended as an extra file diff). After every edit the hunk header counts and new-file offsets were recomputed from the line prefixes, and `validate.ts` re-checks them. Planted diffs are synthetic derivatives: the `commit` field is the base commit the real diff came from, and the injected change never existed upstream. Each upstream diff keeps the license of its repository (see `license` per row).

## Files

- `manifest.jsonl`: one JSON object per case.
- `diffs/<id>.diff`: the unified diff for that case.
- `validate.ts`: dependency-free check (`bun bench/validate.ts`), exits 1 on failure.

## Manifest fields

| field | meaning |
|---|---|
| `id` | `clean-NN`, ... (ids of `heldout2` carry the prefix `h2-`: `h2-clean-NN`, `h2-skip-NN`, ...); `skip-NN`, `only-NN`, `tsupp-NN` (type-suppress), `lint-NN` (lint-suppress), `assertrm-NN` (assert-removed), `testdel-NN` (test-deleted), `thresh-NN` (threshold-lowered) |
| `set` | `dev` (tune against these), `heldout` (the first held-out set, now consumed, see below) or `heldout2` (the second held-out set, report numbers on these only) |
| `repo`, `commit`, `license` | upstream repository, base commit SHA, SPDX license id |
| `lang` | `ts`, `js` or `py`, by the file that carries the defect (clean: by the files touched) |
| `planted` | `true` if a defect was injected |
| `expected` | list of `{class, file}`; empty for clean cases. Classes: `skip`, `only`, `type-suppress`, `lint-suppress`, `assert-removed`, `test-deleted`, `threshold-lowered` |
| `variant` | the concrete spelling or form used (`it.skip`, `mark.xfail`, `ts-nocheck`, `file-deleted`, ...) |
| `note` | what was injected and where, or why a clean case is tricky |
| `also_acceptable` | only on `test-deleted` cases: `["assert-removed"]`, because deleting a test inevitably removes its assertions; a scorer should not count that second finding as a false positive |

## Held-out split

20 of 70 cases are `heldout`, every class and clean cases included. They were picked pseudo-randomly (seeded hash) from the subtler variants first (for example `xfail`, `describe.skip`, `fdescribe`, `@ts-nocheck`, `biome-ignore`, `# noqa` on an import, a one-point threshold drop, whole-file deletion, and tricky clean cases), so they are not the easy ones.

## Held-out split 2 (`heldout2`)

**Why it exists.** The first held-out set (`heldout`, 20 cases) is consumed: after a false alarm on one of its cases was inspected and the detector was adjusted in response, it no longer measures generalization. `heldout2` is a fresh set frozen on 2026-11-13, built without reading the detector's source, tests, results or README, so no case was shaped by the implementation. Report generalization numbers on `heldout2` only, and treat it as consumed the first time a miss on it drives a change; the next set then needs a new name and a new freeze date.

**Provenance.** 44 cases (17 clean, 27 planted) from real public commits of 17 repositories that appear nowhere in `dev` or `heldout` (`validate.ts` enforces the disjointness). Diffs were fetched read-only with `gh api repos/<owner>/<repo>/commits/<sha> -H "Accept: application/vnd.github.diff"`. Licenses are MIT or BSD-3-Clause, TypeScript/JavaScript and Python mixed. Clean cases are whole commit diffs, byte for byte as upstream wrote them (no trimming). They were picked to look like what a gate might wrongly flag: tests folded into `@pytest.mark.parametrize`, `params=` fixtures or `test.each`, tests split across files or into `describe` blocks, test files renamed or deleted and recreated elsewhere, test titles renamed, assertions rewritten one-to-one, a `skipIf` wrapper removed, plus a few plain fix commits. Planted cases (4 per class, 3 for `only`) follow the construction rules in the Provenance section above, each from its own base commit and with exactly one injected defect; `commit` is again the base commit and the injected change never existed upstream. Test deletions and threshold drops are appended as extra file diffs against files the base commit does not touch, read at that commit.

**One variant relaxes the clean-case line counts.** Folding tests lowers the number of `it(`/`def test_` lines without losing coverage, so the generic "no net loss of test or assertion lines" check in `validate.ts` does not apply to a `heldout2` clean row with variant `parametrized` (it instead requires an added `parametrize`, `.each` or `params=` line). Every other clean row, including all rows of `dev` and `heldout`, keeps the original check. The marker checks (no added skip, only, suppression or lowered threshold) apply to all clean rows.

## Labeling conventions

- A clean case is clean with respect to the seven classes only. It may contain unrelated bugs or style issues.
- "Assertions removed and rewritten one-to-one" counts as clean: the number of assertions does not drop and the replacement checks the same behavior.
- `expected.file` is the path on the new side of the diff (for renames, the new path).
