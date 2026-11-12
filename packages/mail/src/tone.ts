import type { MailSettings } from './defaults'

// The colour a use takes from the settings' palette: `accent` is the button colour, `neutral` the plain one, `danger` the one for what destroys or fails.
export type Tone = 'accent' | 'neutral' | 'danger'
export type Align = 'left' | 'center' | 'right'

// What `danger` and `onDanger` are when the settings give none.
export const DANGER = '#b42318'
export const ON_DANGER = '#ffffff'

// A component's own style with the use's `style` after it, so the use wins.
export function withStyle(own: string, extra: string | undefined): string {
  return extra === undefined || extra === '' ? own : `${own};${extra}`
}

// `text-align` for a block that takes `align`.
export function alignStyle(align: Align | undefined): string {
  return align === undefined ? '' : `;text-align:${align}`
}

// A button's class (the dark mode recolours it) and colours.
export function buttonTone(settings: MailSettings, tone: Tone): { className: string, style: string, underline: string } {
  if (tone === 'danger') {
    const danger = settings.danger ?? DANGER

    return { className: 'km-button-danger', style: `background:${danger};color:${settings.onDanger ?? ON_DANGER}`, underline: danger }
  }

  if (tone === 'neutral')
    return { className: 'km-button-neutral', style: `background:${settings.background};color:${settings.text};border:1px solid ${settings.border}`, underline: settings.background }

  return { className: 'km-button', style: `background:${settings.accent};color:${settings.onAccent}`, underline: settings.accent }
}

// The class and colour of text in a tone; `base` is what it takes with no tone.
export function textTone(settings: MailSettings, tone: Tone | undefined, base: 'text' | 'muted'): { className: string, color: string } {
  if (tone === 'danger')
    return { className: 'km-danger', color: settings.danger ?? DANGER }

  if (tone === 'accent')
    return { className: 'km-accent', color: settings.accent }

  if (tone === 'neutral' || base === 'text')
    return { className: 'km-text', color: settings.text }

  return { className: 'km-muted', color: settings.muted }
}

// A link's own attributes, `rel="noopener noreferrer"` added to one opening a new tab. `target` is passed only when written, as a template's `target={expr}`, even `undefined`, stops kay opening a link that leaves the site in a new tab.
export function linkAttributes<T extends { target?: unknown, rel?: unknown }>(attributes: T): T {
  return attributes.target === '_blank' && attributes.rel === undefined ? { ...attributes, rel: 'noopener noreferrer' } : attributes
}
