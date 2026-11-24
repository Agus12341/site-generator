[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Agus12341/site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Agus12341/site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator - a faster makefun-site

An entry for make.fun's [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122) bounty.

`solve.js` is a drop-in replacement for makefun-site 1.0.0: its `run(input)` returns the same output tree as makefun-site's `build` for every input, byte for byte. `main.ts` is the harness driver: it reads the cases from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

The speed comes from the hot paths: text helpers scan by char code and return the input untouched when there is nothing to change, the inline Markdown renderer works on ranges of the string the caller already holds instead of slicing copies, front matter slices only its own lines out of the source, word counts are a single pass, template loops reuse their scope across iterations, and each post's card and each date's long form are computed once per build.

Local results on the kit's practice set: the scorer reports `{"passed":1,"cases_passed":3,"cases_total":3}`, the answers are byte-identical to the house baseline's, and the entry runs about 1.5x the baseline's speed (median CPU, whole harness process).

## License

MIT - see `LICENSE`.
