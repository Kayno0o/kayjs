import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { NewTab } from './outside'

interface SwitcherAppBase {
  href: string
  label: string
  // Drawn above the name; an app with none shows the first letter of its name.
  icon?: IconSlot | IconProps | undefined
  // Shown as the tile's tooltip.
  description?: string | undefined
  // Opens this app in a new tab, keeps it in the same one when `false`, or opens it in a new tab when it leaves the site with `'auto'`, whatever the switcher does.
  newTab?: NewTab | undefined
  // The tile's `rel` when it opens in a new tab, `noopener noreferrer` by default.
  rel?: string | undefined
}

// An app of the family an AppSwitcher links to. `key` is matched against the switcher's `current` to mark the app on screen; `id` is the name it had before 1.99.
export type SwitcherApp = SwitcherAppBase & ({ key: string, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ id?: string | undefined } | { key?: undefined, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-items` finds it. */ id: string })

// An app as a `@tile(app)` block reads it: `key` always there.
export type KeyedSwitcherApp = SwitcherApp & { key: string }

export function keyedApp(app: SwitcherApp): KeyedSwitcherApp {
  return app.key === undefined ? { ...app, key: app.id } : app
}

export function appKey(app: SwitcherApp): string {
  return app.key ?? app.id
}
