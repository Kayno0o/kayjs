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
