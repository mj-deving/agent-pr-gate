# agent-pr-gate benchmark

**Provenance.** The cases are unified diffs taken from real public commits of 22 GitHub repositories under MIT, Apache-2.0 or BSD-3-Clause licenses (TypeScript/JavaScript and Python), fetched read-only with `gh api repos/<owner>/<repo>/commits/<sha> -H "Accept: application/vnd.github.diff"`. The dataset was built independently of any detector implementation. Clean cases (24) are real diffs left byte-for-byte as upstream wrote them, apart from a few that were trimmed to a subset of their files; they were screened so that they contain none of the target defects, and they include deliberately tricky ones (raised coverage thresholds, renamed or moved test files, the word "skip" in test titles and identifiers, assertions removed and rewritten one-to-one). Planted cases (46) start from a different real diff each and receive exactly one injected defect of the kind a coding agent would produce: `.skip`/`xit`/`@pytest.mark.skip|skipif|xfail`/`@unittest.skip` on a newly added test, `.only`/`fit`/`fdescribe` left on a new test, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`/`# type: ignore` on an added line, `eslint-disable*`/`biome-ignore`/`# noqa`/`# pylint: disable`, an existing assertion line turned into a removed line, a test case or whole test file deleted (cut from the file as it exists at the base commit), or a coverage threshold lowered in `vitest.config.ts`, `package.json` or `pyproject.toml` (edited against the config file as it exists at the base commit, appended as an extra file diff). After every edit the hunk header counts and new-file offsets were recomputed from the line prefixes, and `validate.ts` re-checks them. Planted diffs are synthetic derivatives: the `commit` field is the base commit the real diff came from, and the injected change never existed upstream. Each upstream diff keeps the license of its repository (see `license` per row).

## Files

- `manifest.jsonl`: one JSON object per case.
- `diffs/<id>.diff`: the unified diff for that case.
- `validate.ts`: dependency-free check (`bun bench/validate.ts`), exits 1 on failure.

## Manifest fields

| field | meaning |
|---|---|
| `id` | `clean-NN`, `skip-NN`, `only-NN`, `tsupp-NN` (type-suppress), `lint-NN` (lint-suppress), `assertrm-NN` (assert-removed), `testdel-NN` (test-deleted), `thresh-NN` (threshold-lowered) |
| `set` | `dev` (tune against these) or `heldout` (report numbers on these only) |
| `repo`, `commit`, `license` | upstream repository, base commit SHA, SPDX license id |
| `lang` | `ts`, `js` or `py`, by the file that carries the defect (clean: by the files touched) |
| `planted` | `true` if a defect was injected |
| `expected` | list of `{class, file}`; empty for clean cases. Classes: `skip`, `only`, `type-suppress`, `lint-suppress`, `assert-removed`, `test-deleted`, `threshold-lowered` |
| `variant` | the concrete spelling or form used (`it.skip`, `mark.xfail`, `ts-nocheck`, `file-deleted`, ...) |
| `note` | what was injected and where, or why a clean case is tricky |
| `also_acceptable` | only on `test-deleted` cases: `["assert-removed"]`, because deleting a test inevitably removes its assertions; a scorer should not count that second finding as a false positive |

## Held-out split

20 of 70 cases are `heldout`, every class and clean cases included. They were picked pseudo-randomly (seeded hash) from the subtler variants first (for example `xfail`, `describe.skip`, `fdescribe`, `@ts-nocheck`, `biome-ignore`, `# noqa` on an import, a one-point threshold drop, whole-file deletion, and tricky clean cases), so they are not the easy ones.

## Labeling conventions

- A clean case is clean with respect to the seven classes only. It may contain unrelated bugs or style issues.
- "Assertions removed and rewritten one-to-one" counts as clean: the number of assertions does not drop and the replacement checks the same behavior.
- `expected.file` is the path on the new side of the diff (for renames, the new path).
