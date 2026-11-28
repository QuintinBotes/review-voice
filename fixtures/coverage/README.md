# Coverage fixtures

Recorded coverage reports for the coverage adapter (issue 547,
`docs/adr/0003`). Every file is synthetic: a two-function cart module in
JavaScript and in Python, and `change.patch`, the diff that adds
`applyCoupon` / `apply_coupon` and modifies line 4 of each. These are flat
files, not case directories, because `test/fixtures.test.mjs` treats every
`fixtures/<group>/<name>/` directory as a review case.

`test/issue-547-coverage-adapter.test.mjs` states the uncovered changed lines
each report gives against `change.patch`. The absolute paths under
`/home/runner/work/shop/shop` are replaced with the test's own directory.

| File | Tool whose output it is | Exercises | Confirmed against a real run |
|---|---|---|---|
| `node-test.lcov.info` | Node 26 `node --test --experimental-test-coverage --test-reporter=lcov` | relative `SF:` paths, `DA` for every line, `BRDA` and `FNDA` records the adapter ignores | yes, written by that command |
| `c8.lcov.info` | c8 (istanbul's `lcovonly` reporter) | absolute `SF:` paths, a second record for a file the change does not touch | no |
| `coverage-py.cobertura.xml` | coverage.py 7.6 `coverage xml` | a `<source>` root with relative `filename`s, self-closing `<lines/>`, a file the change does not touch, statements only | no; its two comments lose the URLs the tool writes, as the other fixtures keep none |
