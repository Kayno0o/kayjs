import type { Lint } from './lints'

// The lints of the `deprecated` group that came in 1.106, with the others in `DEPRECATED_LINTS`.
export const SCHEMA_BUILDERS = {
  'deprecated-schema-builders': {
    level: 'warn',
    group: 'deprecated',
    since: '1.106',
    site: true,
    summary: 'The PascalCase builders of `s` before 1.106, which kay\'s own lowercase builders replace, each taking the same field options (`optional`, `default`, `error`, `label`, `description`, `example`) and short names for the rest: `s.String` is `s.string` (`min`, `max`), `s.Integer` `s.int`, `s.Number` and `s.Numeric` `s.number`, `s.Boolean` and `s.BooleanString` `s.boolean`, `s.Array` `s.list`, `s.UnionEnum` and `s.UnionKeys` `s.enum`, and `s.Date`, `s.Literal`, `s.Union`, `s.Object`, `s.File`, `s.Files`, `s.Secret` and `s.Public` their lowercase names; `s.Optional(field)` is `optional: true` in the options of the field; an `s.Object({ ... })` that is the schema of an `action` or a `defineEnv` is the record of fields alone; an `s.Object` given as the `query`, `params`, `headers` or `cookie` of a route keeps `{ extra: \'strip\' }`, as a visitor sends keys the schema does not name; and a file size written `\'2m\'` is `\'2mb\'`. The old names work until 2.0. Found on the `s` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files. The fix renames the builder and the options that changed; an `s.Optional` around anything but one of these builders, such as a helper of `kay/content`, is left as it is. A lowercase `s.object` refuses a key its shape lacks with a 422, where `s.Object` let it by: write `{ extra: \'strip\' }` where the old way is wanted.',
    wrong: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String({ maxLength: 200 }), note: s.Optional(s.String()) }), ({ title }) => title)\n---\np x',
    right: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ title: s.string({ max: 200 }), note: s.string({ optional: true }) }, ({ title }) => title)\n---\np x',
  },
} as const satisfies Record<string, Lint>
