import type { JSX } from 'kay'
import type { Palette, Settings } from './defaults'

type Triple = [number, number, number]

const HEX = /^#(?:[\da-f]{3}){1,2}$/i
// WCAG's least contrast for text, which the accent keeps as a link on the card and as a button's background behind its text.
const READABLE = 4.5
const LIGHTEN_STEP = 0.02
const LIGHTEST = 0.95

function rgbOf(colour: string): Triple | undefined {
  if (!HEX.test(colour))
    return undefined

  const hex = colour.length === 4 ? [...colour.slice(1)].map(digit => digit + digit).join('') : colour.slice(1)

  return [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as Triple
}

function hexOf(rgb: Triple): string {
  return `#${rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`
}

function hslOf([r, g, b]: Triple): Triple {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  if (d === 0)
    return [0, 0, l]

  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4

  return [h * 60, s, l]
}

function rgbOfHsl([h, s, l]: Triple): Triple {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  const sector = Math.floor(h / 60) % 6
  const [r, g, b]: Triple = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector] as Triple

  return [r + m, g + m, b + m]
}

function luminance(rgb: Triple): number {
  const [r, g, b] = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as Triple

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [x, y] = [rgbOf(a), rgbOf(b)]

  if (x === undefined || y === undefined)
    return 1

  const [lighter, darker] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number]

  return (lighter + 0.05) / (darker + 0.05)
}

// Light turned dark and dark light, hue and saturation kept, neither end pure black or white. A colour that is no hex is kept as it is.
function inverted(colour: string): string {
  const rgb = rgbOf(colour)

  if (rgb === undefined)
    return colour

  const [h, s, l] = hslOf(rgb)

  return hexOf(rgbOfHsl([h, s, 0.08 + (1 - l) * 0.84]))
}

// Lightened until it reads on `ground`.
function readableOn(colour: string, ground: string): string {
  const rgb = rgbOf(colour)

  if (rgb === undefined)
    return colour

  const [h, s, start] = hslOf(rgb)
  let lightness = start
  let result = colour

  while (contrast(result, ground) < READABLE && lightness < LIGHTEST) {
    lightness = Math.min(LIGHTEST, lightness + LIGHTEN_STEP)
    result = hexOf(rgbOfHsl([h, s, lightness]))
  }

  return result
}

// The colours a mail switches to in a client's dark mode: `settings.dark`'s, and for each it leaves out one derived from the light colour.
export function darkPalette(settings: Settings): Palette {
  const given = settings.dark ?? {}
  const surface = given.surface ?? inverted(settings.surface)
  const accent = given.accent ?? readableOn(inverted(settings.accent), surface)
  const onAccent = given.onAccent ?? [settings.onAccent, inverted(settings.onAccent)].toSorted((a, b) => contrast(b, accent) - contrast(a, accent))[0]!

  return {
    text: given.text ?? inverted(settings.text),
    muted: given.muted ?? inverted(settings.muted),
    background: given.background ?? inverted(settings.background),
    surface,
    border: given.border ?? inverted(settings.border),
    accent,
    onAccent,
  }
}

// The classes the components carry, each with what it sets in dark mode.
const RULES: [className: string, declarations: (palette: Palette) => string[]][] = [
  ['km-bg', palette => [`background-color:${palette.background}`]],
  ['km-surface', palette => [`background-color:${palette.surface}`, `border-color:${palette.border}`]],
  ['km-text', palette => [`color:${palette.text}`]],
  ['km-muted', palette => [`color:${palette.muted}`]],
  ['km-border', palette => [`border-color:${palette.border}`]],
  ['km-button', palette => [`background-color:${palette.accent}`, `color:${palette.onAccent}`]],
  ['km-link', palette => [`color:${palette.accent}`]],
]

// Dark colours for clients honouring `prefers-color-scheme`, such as Apple Mail, and for Outlook.com, which marks the elements it recolours with `data-ogsc` and `data-ogsb`. The mail's document moves it into its head.
export function darkStyle(settings: Settings): JSX.Element {
  const palette = darkPalette(settings)
  const rules = (selector: (className: string) => string) => RULES.map(([className, declarations]) => `${selector(className)}{${declarations(palette).map(declaration => `${declaration}!important`).join(';')}}`).join('')

  return { t: `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){${rules(className => `.${className}`)}}${rules(className => `[data-ogsc] .${className},[data-ogsb] .${className}`)}</style>` }
}
