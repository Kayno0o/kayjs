import type { JSX } from 'kay'

// Markup only Outlook for Windows reads, inside a conditional comment. kay templates drop comments, but the server writes a `{ t }` value into the markup as it is.
export function mso(markup: string, condition = 'mso'): JSX.Element {
  return { t: `<!--[if ${condition}]>${markup}<![endif]-->` }
}

// A fixed-width table around content held to `width` by `max-width`, which Outlook ignores.
export function ghostTable(width: number): [open: JSX.Element, close: JSX.Element] {
  return [
    mso(`<table role="presentation" width="${width}" align="center" cellpadding="0" cellspacing="0" border="0" style="width:${width}px"><tr><td>`, 'true'),
    mso('</td></tr></table>', 'true'),
  ]
}

// Fonts every Windows since 7 ships.
const WINDOWS_FONTS = new Set(['arial', 'segoe ui', 'calibri', 'cambria', 'candara', 'consolas', 'constantia', 'corbel', 'courier new', 'georgia', 'lucida console', 'lucida sans unicode', 'palatino linotype', 'tahoma', 'times new roman', 'trebuchet ms', 'verdana'])
const GENERIC = { 'sans-serif': 'Arial', 'serif': 'Georgia', 'monospace': '\'Courier New\'' } as Record<string, string>
const QUOTES = /^['"]|['"]$/g

// The fonts of a stack Windows has, and its generic family: Outlook for Windows is known to try the first font alone and fall back to Times New Roman when it lacks it, as with `system-ui` or a web font.
export function windowsStack(stack: string): string {
  const families = stack.split(',').map(family => family.trim())
  const kept = families.filter(family => WINDOWS_FONTS.has(family.replace(QUOTES, '').toLowerCase()))
  const generic = families.map(family => family.toLowerCase()).find(family => Object.hasOwn(GENERIC, family)) ?? 'sans-serif'

  return [...kept.length > 0 ? kept : [GENERIC[generic]!], generic].join(', ')
}

// The settings' fonts as Outlook for Windows can show them, in a style only it reads; the mail's document moves it into its head.
export function msoFonts(font: string, mono: string): JSX.Element {
  return mso(`<style>body,table,td,th,p,a,span,h1,h2,h3{font-family:${windowsStack(font)}!important}.km-mono{font-family:${windowsStack(mono)}!important}</style>`)
}
