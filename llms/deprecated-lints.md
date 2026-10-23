# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.72` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-ui-prop` | warn | deprecated | Since 1.72, `loading` of kayjs-ui's `Select` is `busy`, `QrCode`'s `size` is `pixels`, `stamp` and `solid` of `Badge` are `variant`, and `compact` of `FormField`, `FileDrop` and `Notice` is `size="sm"`. `kay upgrade` rewrites them. |
| `deprecated-ui-callback` | warn | deprecated | `onOpen` of kayjs-ui's `ConfirmDelete` and `onSidebarClose` of `SplitLayout`, since 1.72: they are `onOpenChange` and `onSidebarOpenChange` now. `kay upgrade` renames `onSidebarClose` where the handler is written `() => ...`, and leaves `onOpen` (`onOpenChange` is called on closing too). |
| `deprecated-step-draft-max-age` | warn | deprecated | A kayjs-ui `stepDraft` giving `maxAge` as a number of seconds, since 1.73: it is a duration (`3600` is `'1h'`). Read until 1.76. `kay upgrade` rewrites a numeric literal. Found in `stepDraft(...)` calls with an object literal, in `.ts` files and `.kay` fences. |
| `deprecated-message-key` | warn | deprecated | A `ui.*` or `cms.*` key of `src/messages/<locale>.ts` still ending in `Label`, since 1.72: it is the bare name now (`ui.table.filter`), or ends in `Aria` where a visible text had the name. Read until 1.75. `kay upgrade` renames the key. |
| `deprecated-ui-token` | warn | deprecated | A kayjs-ui theme token under its old prefixed name since 1.72 (`--color-kui-canvas`, `--kui-density`, `bg-kui-surface2`), now the app's own theme name (`--color-background`, `--density`, `bg-border`). Read until 1.75. `kay check --fix` rewrites references and utilities in `.css`, `.kay` and src/ui.ts, and a declaration where the new name reads the old one and the block does not set it; a name folded into a recipe or made private is reported, naming the part to set in src/ui.ts. |
