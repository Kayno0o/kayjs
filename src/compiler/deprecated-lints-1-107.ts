import type { Lint } from './lints'

// The lints of the `deprecated` group that came in 1.107, with the others in `DEPRECATED_LINTS`.
export const ACTION_OPTIONS = {
  'deprecated-action-options': {
    level: 'warn',
    group: 'deprecated',
    since: '1.107',
    site: true,
    summary: 'The arguments of `action` before 1.107, `action(schema, handler, options)` and `action(handler, options)`: the options come first, with the input in them, as an API route\'s do, `action({ input: schema, ...options }, handler)` and `action(options, handler)`. `input` is a plain record of fields or any schema. The old forms work until 2.0. Found on the `action` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files; the fix moves the arguments and keeps their text.',
    wrong: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ title: s.string() }, ({ title }) => title, { maxSize: \'1mb\' })\n---\np x',
    right: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ input: { title: s.string() }, maxSize: \'1mb\' }, ({ title }) => title)\n---\np x',
  },
} as const satisfies Record<string, Lint>
