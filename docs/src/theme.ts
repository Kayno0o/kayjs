import { signal } from 'kay'

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
  { value: 'green', label: 'Green', tokens: { '--color-kui-accent': 'light-dark(#2c7339, #7cc98a)', '--color-kui-accent-hi': 'light-dark(#215a2c, #9bd8a6)', '--color-kui-on-accent': 'light-dark(#ffffff, #0f2214)' } },
  { value: 'red', label: 'Red', tokens: { '--color-kui-accent': 'light-dark(#b8483d, #ec9086)', '--color-kui-accent-hi': 'light-dark(#a03a30, #f4a79d)', '--color-kui-on-accent': 'light-dark(#ffffff, #1a0d0b)' } },
  { value: 'violet', label: 'Violet', tokens: { '--color-kui-accent': 'light-dark(#6346a0, #b9a3de)', '--color-kui-accent-hi': 'light-dark(#4f3683, #cbb9e8)', '--color-kui-on-accent': 'light-dark(#ffffff, #1a1230)' } },
]

export const SCHEMES: { value: Scheme, label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]

const KEY = 'kay-docs-theme'
const DEFAULT: Theme = { scheme: 'system', accent: ACCENTS[0]!.value }
const TOKENS = Object.keys(ACCENTS[0]!.tokens)
// The tokens each accent sets on `html`; the docs' own sets none, site.css holding it.
const OVERRIDES: Record<string, Record<string, string>> = Object.fromEntries(ACCENTS.slice(1).map(accent => [accent.value, accent.tokens]))

function stored(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Theme>

    return {
      scheme: SCHEMES.find(scheme => scheme.value === saved.scheme)?.value ?? DEFAULT.scheme,
      accent: ACCENTS.find(accent => accent.value === saved.accent)?.value ?? DEFAULT.accent,
    }
  }
  catch {
    return DEFAULT
  }
}

// What the visitor picked on an earlier visit, read in the browser; the server renders the default.
export const theme = signal<Theme>(typeof localStorage === 'undefined' ? DEFAULT : stored())

// Shows the theme at once and keeps it for the next pages and visits: the scheme as kayjs-ui's `data-theme`, the accent as its tokens on `html`.
export function pickTheme(change: Partial<Theme>) {
  const next = { ...theme(), ...change }
  const root = document.documentElement

  theme.set(next)

  if (next.scheme === 'system')
    delete root.dataset.theme
  else
    root.dataset.theme = next.scheme

  for (const name of TOKENS)
    root.style.removeProperty(name)

  for (const [name, value] of Object.entries(OVERRIDES[next.accent] ?? {}))
    root.style.setProperty(name, value)

  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  }
  catch {}
}

// What pickTheme does, run in the head before the page paints, so a visit never flashes the default theme first.
export const THEME_SCRIPT = `try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})||"{}"),r=document.documentElement,a=${JSON.stringify(OVERRIDES)}[t.accent]||{};if(t.scheme==="light"||t.scheme==="dark")r.dataset.theme=t.scheme;for(var k in a)r.style.setProperty(k,a[k])}catch(e){}`

// The `@theme` an app sets for the accent picked.
export function themeCss(picked: Theme): string {
  const accent = ACCENTS.find(one => one.value === picked.accent) ?? ACCENTS[0]!

  return `@theme {\n${Object.entries(accent.tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`
}
