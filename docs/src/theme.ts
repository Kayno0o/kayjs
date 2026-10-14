import { persisted } from 'kay'

export type Scheme = 'system' | 'light' | 'dark'

export interface Theme {
  scheme: Scheme
  palette: string
}

// The themes the header offers, each a whole palette in palettes.ts; the first is the docs' own, which palettes.css sets on the root.
export const THEMES: { value: string, label: string }[] = [
  { value: 'kay', label: 'kay' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'nord', label: 'Nord' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
]

export const SCHEMES: { value: Scheme, label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]

// Kept in localStorage: the server and the islands as they hydrate render the defaults, and kay applies the visitor's after.
export const scheme = persisted<Scheme>('kay-docs-scheme', 'system', { storage: 'local' })
export const palette = persisted<string>('kay-docs-palette', THEMES[0]!.value, { storage: 'local' })

// Shows the theme at once, the scheme as kayjs-ui's `data-theme` and the palette as `data-palette` on `html`, which kay keeps for the next pages and visits.
export function pickTheme(change: Partial<Theme>) {
  const root = document.documentElement

  if (change.scheme !== undefined) {
    scheme.set(change.scheme)

    if (change.scheme === 'system')
      delete root.dataset.theme
    else
      root.dataset.theme = change.scheme
  }

  if (change.palette !== undefined) {
    palette.set(change.palette)

    if (change.palette === THEMES[0]!.value)
      delete root.dataset.palette
    else
      root.dataset.palette = change.palette
  }
}

// What pickTheme does, run in the head before the page paints so a visit never flashes the default theme first, reading each value as kay keeps a persisted string, `["dark"]`.
export const THEME_SCRIPT = `try{var r=document.documentElement,v=function(k){try{return JSON.parse(localStorage.getItem(k))[0]}catch(e){}},s=v("kay-docs-scheme"),p=v("kay-docs-palette");if(s==="light"||s==="dark")r.dataset.theme=s;if(${JSON.stringify(THEMES.slice(1).map(theme => theme.value))}.indexOf(p)>=0)r.dataset.palette=p}catch(e){}`
