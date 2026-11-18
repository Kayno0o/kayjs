import type { Lint } from './lints'

import { SCHEMA_BUILDERS } from './deprecated-lints-1-106'
import { ACTION_OPTIONS } from './deprecated-lints-1-107'

// The lints of the `deprecated` group, with the other lints in `LINTS`; each stays three minors from its `since`.
export const DEPRECATED_LINTS = {
  ...SCHEMA_BUILDERS,
  ...ACTION_OPTIONS,

  'deprecated-ui-props': {
    level: 'warn',
    group: 'deprecated',
    since: '1.98',
    summary: 'A kayjs-ui or kayjs-ai prop under its name before 1.98. `heading` on a Dialog, SidePanel or FormDialog is `title`, which takes a string or a `@title` block as a Card\'s does, and the string that named the dialog for screen readers is `label`. `variant` on a Stat, Chat or ChatLauncher is `layout`, `variant` naming only the frame of a control. The old names work until 2.0. The fix renames the prop or the block, and the `title` string beside a `heading` to `label`; it offers none where the new name is already written.',
    wrong: '---\nimport Stat from \'@kayjs/ui/stat.kay\'\n---\nStat(value={12} label="moons" variant="tile")',
    right: '---\nimport Stat from \'@kayjs/ui/stat.kay\'\n---\nStat(value={12} label="moons" layout="tile")',
  },
} as const satisfies Record<string, Lint>

// Every minor that shipped deprecated lints, and the release that dropped them with the old forms they rewrote, none while they are still declared: a release newer than `removedIn` no longer rewrites those forms, so `kay upgrade` installs the minor before it first, whose kay still does. `tests/upgrade.test.ts` fails for a lint whose minor is not listed and for a minor listed as live with no lint left, so dropping the last lint of a minor means writing its `removedIn` here.
export const DEPRECATION_MINORS: readonly { since: string, removedIn?: string }[] = [
  { since: '1.46', removedIn: '1.51' },
  { since: '1.51', removedIn: '1.56' },
  { since: '1.52', removedIn: '1.56' },
  { since: '1.55', removedIn: '1.60' },
  { since: '1.56', removedIn: '1.60' },
  { since: '1.69', removedIn: '1.73' },
  { since: '1.70', removedIn: '1.74' },
  { since: '1.71', removedIn: '1.74' },
  { since: '1.72', removedIn: '1.75' },
  { since: '1.74', removedIn: '1.77' },
  { since: '1.81', removedIn: '1.85' },
  { since: '1.82', removedIn: '1.86' },
  { since: '1.84', removedIn: '1.88' },
  { since: '1.87', removedIn: '1.91' },
  { since: '1.88', removedIn: '1.92' },
  { since: '1.89', removedIn: '1.93' },
  { since: '1.90', removedIn: '1.94' },
  { since: '1.91', removedIn: '1.95' },
  { since: '1.92', removedIn: '1.105' },
  { since: '1.96', removedIn: '1.100' },
  { since: '1.97', removedIn: '1.101' },
  { since: '1.98' },
  { since: '1.99', removedIn: '1.103' },
  { since: '1.100', removedIn: '1.104' },
  { since: '1.101', removedIn: '1.105' },
  { since: '1.102', removedIn: '1.107' },
  { since: '1.103', removedIn: '1.107' },
  { since: '1.104', removedIn: '1.108' },
  { since: '1.105', removedIn: '1.109' },
  { since: '1.106' },
  { since: '1.107' },
]
