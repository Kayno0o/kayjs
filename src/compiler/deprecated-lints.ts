import type { Lint } from './lints'

// The lints of the `deprecated` group, with the other lints in `LINTS`; each stays three minors from its `since`.
export const DEPRECATED_LINTS = {
  'deprecated-local-state': {
    level: 'warn',
    group: 'deprecated',
    since: '1.92',
    site: true,
    summary: '`pending()` and `status()` of a `local()` collection, `unsynced()` and `syncStatus()` since 1.92: every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`, so the count of writes waiting and the sync states took names of their own. The old names work until 2.0, which gives `pending()` and `status()` the meaning they have on every source, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. Found in the TypeScript files and `.kay` files of the project, templates included, on a name bound once to a call of `local` from `kay`, as `kay check` reads no types: a collection reached through a property, a prop or another file is not found. The fix renames the method, and a `status()` compared with a string (`===`, `!==`, `==`, `!=` or a `switch`) reads `\'unsynced\'` for `\'pending\'`; a `status()` read in any other way is reported with no fix.',
    wrong: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.pending()} waiting',
    right: '---\nimport { local } from \'kay\'\nimport { save } from \'./notes\'\n\nconst notes = local({ key: \'id\', read: () => [], put: save })\n---\np {notes.unsynced()} waiting',
  },
  'deprecated-redirect-permanent': {
    level: 'warn',
    group: 'deprecated',
    since: '1.96',
    site: true,
    summary: '`permanent` of a redirect in `kay.config.ts`, `status` since 1.96: `status` is the one spelling for 301, 302, 307, 308 and 410 (a path that is gone, with no `to`), where `permanent` named two of them and could contradict it. The old form still works. Found in the `redirects` object of `kay.config.ts`, through a `const` it names. The fix writes `status: 307` for `permanent: false`, and drops `permanent: true`, which is the 308 default, and `permanent` beside a `status` that agrees; any other form is reported with no fix. A static export lists a `status` as written in `_redirects`, where `permanent: false` was listed as 302, so it lists 307 after the fix.',
    wrong: '// kay.config.ts\nexport default { redirects: { \'/sale\': { to: \'/offers\', permanent: false } } }',
    right: '// kay.config.ts\nexport default { redirects: { \'/sale\': { to: \'/offers\', status: 307 } } }',
  },
  'deprecated-ui-hotkey': {
    level: 'warn',
    group: 'deprecated',
    since: '1.97',
    site: true,
    summary: '`hotkey` of a kayjs-ui Toaster or CommandPalette, `shortcut` since 1.97: the full chord, as SaveForm\'s `shortcut` already is (`alt+t` for the Toaster, `mod+k` for the CommandPalette by default), with `false` or `null` turning it off on all three. `hotkey` still works. Found on a `Toaster` or `CommandPalette` element of a `.kay` file of an app using kayjs-ui. The fix writes `shortcut` with the Alt (Toaster) or Ctrl or Cmd (CommandPalette) chord for a literal key, and `shortcut={null}` for `hotkey={null}`; any other value is reported with no fix.',
    wrong: '---\nimport Toaster from \'@kaynooo/kayjs-ui/toaster.kay\'\n---\nToaster(hotkey="j")',
    right: '---\nimport Toaster from \'@kaynooo/kayjs-ui/toaster.kay\'\n---\nToaster(shortcut="alt+j")',
  },
  'deprecated-schedule-tz': {
    level: 'warn',
    group: 'deprecated',
    since: '1.97',
    site: true,
    summary: '`tz` in the options of `schedule()`, `timeZone` since 1.97: the option has the name of the `timeZone` of `kay.config.ts`, which it falls back to. The old form still works. Found in the TypeScript files and `.kay` files of the project, on a call of `schedule` imported from `kay/server` or `kay`, in the options object written in the call. The fix renames the key, and writes `timeZone: tz` for a shorthand `{ tz }`; an object holding a `timeZone` already is reported with no fix.',
    wrong: '---\nimport { schedule } from \'kay/server\'\n\nexport default schedule(\'30 2 * * MON\', () => undefined, { tz: \'Europe/Paris\' })\n---',
    right: '---\nimport { schedule } from \'kay/server\'\n\nexport default schedule(\'30 2 * * MON\', () => undefined, { timeZone: \'Europe/Paris\' })\n---',
  },
  'deprecated-ui-props': {
    level: 'warn',
    group: 'deprecated',
    since: '1.97',
    summary: 'A kayjs-ui or kayjs-ai prop under its name before 1.97. `heading` on a Dialog, SidePanel or FormDialog is `title`, which takes a string or a `@title` block as a Card\'s does, and the string that named the dialog for screen readers is `label`. `variant` on a Stat, Chat or ChatLauncher is `layout`, `variant` naming only the frame of a control. The old names work until 2.0. The fix renames the prop or the block, and the `title` string beside a `heading` to `label`; it offers none where the new name is already written.',
    wrong: '---\nimport Stat from \'@kaynooo/kayjs-ui/stat.kay\'\n---\nStat(value={12} label="moons" variant="tile")',
    right: '---\nimport Stat from \'@kaynooo/kayjs-ui/stat.kay\'\n---\nStat(value={12} label="moons" layout="tile")',
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
  { since: '1.92' },
  { since: '1.96' },
  { since: '1.97' },
]
