# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-step-draft-max-age` | warn | deprecated | A kayjs-ui `stepDraft` giving `maxAge` as a number of seconds, since 1.74: it is a duration (`3600` is `'1h'`). Read until 1.77. `kay upgrade` rewrites a numeric literal. Found in `stepDraft(...)` calls with an object literal, in `.ts` files and `.kay` fences. |
