import { BUTTON_FORM_ATTRIBUTE, BUTTON_FORM_KEY } from '../runtime/button-form'

const RULE = `form[${BUTTON_FORM_ATTRIBUTE}]{display:contents}`

// The rule giving that form no box, in a `style` element a strict `style-src` lets through by its hash. A page goes without it unless its markup holds such a form, an island it renders writes one (which it may render only in the browser), or a streamed part may.
export function buttonFormRule(markup: string, streamed: boolean, islandKeys: ReadonlySet<string>): string {
  return streamed || islandKeys.has(BUTTON_FORM_KEY) || markup.includes(` ${BUTTON_FORM_ATTRIBUTE}`) ? `<style>${RULE}</style>` : ''
}

// The message keys an island page sends, without the flag the islands raise.
export function withoutButtonForm(keys: ReadonlySet<string>): Set<string> {
  const words = new Set(keys)

  words.delete(BUTTON_FORM_KEY)

  return words
}

// The css of the rule, which the style policy hashes at start.
export const BUTTON_FORM_STYLE = RULE
