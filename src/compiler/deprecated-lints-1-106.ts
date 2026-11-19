import type { Lint } from './lints'

// The lints of the `deprecated` group that came in 1.106, with the others in `DEPRECATED_LINTS`.
export const SCHEMA_BUILDERS = {
  'deprecated-schema-builders': {
    level: 'warn',
    group: 'deprecated',
    since: '1.106',
    site: true,
    summary: 'The PascalCase builders of `s` before 1.106, which kay\'s own lowercase builders replace, each taking the same field options (`optional`, `default`, `error`, `label`, `description`, `example`) and short names for the rest: `s.String` is `s.string` (`min`, `max`), `s.Integer` `s.int`, `s.Number` and `s.Numeric` `s.number`, `s.Boolean` and `s.BooleanString` `s.boolean`, `s.Array` `s.list`, `s.UnionEnum` and `s.UnionKeys` `s.enum`, and `s.Date`, `s.Literal`, `s.Union`, `s.Object`, `s.File`, `s.Files`, `s.Secret` and `s.Public` their lowercase names; `s.Optional(field)` is `optional: true` in the options of the field; and a file size written `\'2m\'` is `\'2mb\'`. The old names work until 2.0. Found on the `s` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files. The fix renames the builder and the options that changed, and keeps what each did: an `s.Array` takes `max: Number.MAX_SAFE_INTEGER` (the lowercase list stops at 1,000 items) and an `s.Object` `extra: \'strip\'`, a rewrite whose options are not an object literal being reported without a fix; an `s.Union` of `Object.keys(R).map(key => s.Literal(key))` is `s.enum(R)`, and any other `s.Union` of a mapped array is reported without a fix; an `s.Optional` around anything but one of these builders, such as a helper of `kay/content`, is left as it is. A lowercase `s.object` refuses a key its shape lacks where kay reads the schema itself (an action\'s input, an API route\'s body, `defineEnv`, collection frontmatter), where `s.Object` let it by, so the fix writes `{ extra: \'strip\' }`. A query, the headers and the cookies of a request carry keys no schema names, so their unknown keys are dropped whatever the schema says.',
    wrong: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String({ maxLength: 200 }), note: s.Optional(s.String()) }), ({ title }) => title)\n---\np x',
    right: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.object({ title: s.string({ max: 200 }), note: s.string({ optional: true }) }, { extra: \'strip\' }), ({ title }) => title)\n---\np x',
  },
} as const satisfies Record<string, Lint>
