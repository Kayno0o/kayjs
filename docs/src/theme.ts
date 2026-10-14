import { persisted } from 'kay'

export type Scheme = 'system' | 'light' | 'dark'

export interface Theme {
  scheme: Scheme
  accent: string
}

interface Accent {
  value: string
  label: string
  // kayjs-ui's accent tokens, each `light-dark(light, dark)`.
  tokens: Record<string, string>
}

// The first is the docs' own, which site.css sets: picking it takes the others off.
export const ACCENTS: Accent[] = [
  { value: 'yellow', label: 'Yellow', tokens: { '--color-kui-accent': 'light-dark(#8a5700, #f5b83d)', '--color-kui-accent-hi': 'light-dark(#6e4500, #f8ca6b)', '--color-kui-on-accent': 'light-dark(#ffffff, #17202e)' } },
  { value: 'blue', label: 'Blue', tokens: { '--color-kui-accent': 'light-dark(#2459b8, #7aa8f0)', '--color-kui-accent-hi': 'light-dark(#1b4691, #9cbff5)', '--color-kui-on-accent': 'light-dark(#ffffff, #0f1a2e)' } },
  { value: 'green', label: 'Green', tokens: { '--color-kui-accent': 'light-dark(#24662f, #7cc98a)', '--color-kui-accent-hi': 'light-dark(#1b5025, #9bd8a6)', '--color-kui-on-accent': 'light-dark(#ffffff, #0f2214)' } },
  { value: 'red', label: 'Red', tokens: { '--color-kui-accent': 'light-dark(#a63c32, #ec9086)', '--color-kui-accent-hi': 'light-dark(#8f3128, #f4a79d)', '--color-kui-on-accent': 'light-dark(#ffffff, #1a0d0b)' } },
  { value: 'violet', label: 'Violet', tokens: { '--color-kui-accent': 'light-dark(#6346a0, #b9a3de)', '--color-kui-accent-hi': 'light-dark(#4f3683, #cbb9e8)', '--color-kui-on-accent': 'light-dark(#ffffff, #1a1230)' } },
]

export const SCHEMES: { value: Scheme, label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]

const TOKENS = Object.keys(ACCENTS[0]!.tokens)
// The tokens each accent sets on `html`; the docs' own sets none, site.css holding it.
const OVERRIDES: Record<string, Record<string, string>> = Object.fromEntries(ACCENTS.slice(1).map(accent => [accent.value, accent.tokens]))

// Kept in localStorage: the server and the islands as they hydrate render the defaults, and kay applies the visitor's after.
export const scheme = persisted<Scheme>('kay-docs-scheme', 'system', { storage: 'local' })
export const accent = persisted<string>('kay-docs-accent', ACCENTS[0]!.value, { storage: 'local' })

// Shows the theme at once, the scheme as kayjs-ui's `data-theme` and the accent as its tokens on `html`, which kay keeps for the next pages and visits.
export function pickTheme(change: Partial<Theme>) {
  const root = document.documentElement

  if (change.scheme !== undefined) {
    scheme.set(change.scheme)

    if (change.scheme === 'system')
      delete root.dataset.theme
    else
      root.dataset.theme = change.scheme
  }

  if (change.accent !== undefined) {
    accent.set(change.accent)

    for (const name of TOKENS)
      root.style.removeProperty(name)

    for (const [name, value] of Object.entries(OVERRIDES[change.accent] ?? {}))
      root.style.setProperty(name, value)
  }
}

// What pickTheme does, run in the head before the page paints so a visit never flashes the default theme first, reading each value as kay keeps a persisted string, `["dark"]`.
export const THEME_SCRIPT = `try{var r=document.documentElement,v=function(k){try{return JSON.parse(localStorage.getItem(k))[0]}catch(e){}},s=v("kay-docs-scheme"),a=${JSON.stringify(OVERRIDES)}[v("kay-docs-accent")];if(s==="light"||s==="dark")r.dataset.theme=s;if(a)for(var k in a)r.style.setProperty(k,a[k])}catch(e){}`

// The `@theme` an app sets for the accent picked.
export function themeCss(picked: string): string {
  const tokens = (ACCENTS.find(one => one.value === picked) ?? ACCENTS[0]!).tokens

  return `@theme {\n${Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`
}
