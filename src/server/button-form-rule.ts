import { BUTTON_FORM_ATTRIBUTE } from '../runtime/button-form'

const RULE = `form[${BUTTON_FORM_ATTRIBUTE}]{display:contents}`

// The rule giving that form no box, in a `style` element a strict `style-src` lets through by its hash. A page whose markup holds no such form, and whose islands and streamed parts can add none, goes without it.
export function buttonFormRule(markup: string, mayGainForms: boolean): string {
  return mayGainForms || markup.includes(` ${BUTTON_FORM_ATTRIBUTE}`) ? `<style>${RULE}</style>` : ''
}

// The css of the rule, which the style policy hashes at start.
export const BUTTON_FORM_STYLE = RULE
