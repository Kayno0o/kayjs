# Deprecated lints

## Common tasks

- Move an app off every old form at once: `kay upgrade`, or `kay check --fix --since 1.74` for one minor alone; see [Apply the quick fixes](lints.md#apply-the-quick-fixes).

## Reference

### Deprecated lints

The lints of the `deprecated` group, each the old form a minor replaced, reported for three minors with a safe fix unless its row says otherwise.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `deprecated-action-options` | warn | deprecated | The arguments of `action` before 1.107, `action(schema, handler, options)` and `action(handler, options)`: the options come first, with the input in them, as an API route's do, `action({ input: schema, ...options }, handler)` and `action(options, handler)`. `input` is a plain record of fields or any schema. The old forms work until 2.0. Found on the `action` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files; the fix moves the arguments and keeps their text. |
| `deprecated-schema-builders` | warn | deprecated | The PascalCase builders of `s` before 1.106, which kay's own lowercase builders replace, each taking the same field options (`optional`, `default`, `error`, `label`, `description`, `example`) and short names for the rest: `s.String` is `s.string` (`min`, `max`), `s.Integer` `s.int`, `s.Number` and `s.Numeric` `s.number`, `s.Boolean` and `s.BooleanString` `s.boolean`, `s.Array` `s.list`, `s.UnionEnum` and `s.UnionKeys` `s.enum`, and `s.Date`, `s.Literal`, `s.Union`, `s.Object`, `s.File`, `s.Files`, `s.Secret` and `s.Public` their lowercase names; `s.Optional(field)` is `optional: true` in the options of the field; an `s.Object({ ... })` that is the schema of an `action` or a `defineEnv` is the record of fields alone; and a file size written `'2m'` is `'2mb'`. The old names work until 2.0. Found on the `s` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files. The fix renames the builder and the options that changed; an `s.Optional` around anything but one of these builders, such as a helper of `kay/content`, is left as it is. A lowercase `s.object` refuses a key its shape lacks where kay reads the schema itself (an action's input, an API route's body, `defineEnv`, collection frontmatter), where `s.Object` let it by: write `{ extra: 'strip' }` where the old way is wanted. A query, the headers and the cookies of a request carry keys no schema names, so their unknown keys are dropped whatever the schema says. |

The rows of the lints that came in 1.105 are in [Deprecated lints of 1.105](deprecated-lints-1-105.md).
