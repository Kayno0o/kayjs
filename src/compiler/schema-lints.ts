import type { Lint } from './lints'

// The lints about the schemas an app hands the server, with the others in `LINTS`.
export const SCHEMA_LINTS = {
  'schema-without-json-schema': {
    level: 'warn',
    group: 'forms',
    site: true,
    summary: 'A Standard Schema validator with no `~standard.jsonSchema` where an action\'s `input` or an API route\'s `body`, `query`, `params`, `headers` or `cookie` takes a schema: it still validates, but a form shows no constraints, a form or a query is not read as numbers and booleans, and OpenAPI and MCP show an open schema. Read from the source, in `.ts` modules and `.kay` fences: a hand-written object with `~standard` and no `jsonSchema`, and what valibot builds (valibot carries none until `toStandardJsonSchema` from `@valibot/to-json-schema` wraps it), followed through a `const` and a relative import. Zod 4.2+ and ArkType 2.1.28+ carry it.',
    wrong: '--- server\nimport { action } from \'kay\'\nimport * as v from \'valibot\'\n\nexport const add = action({ input: v.object({ title: v.string() }) }, ({ title }) => title)\n---\np x',
    right: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ input: { title: s.string({ max: 200 }) } }, ({ title }) => title)\n---\np x',
  },
} as const satisfies Record<string, Lint>
