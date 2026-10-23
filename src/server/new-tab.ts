import type { Translations } from '../runtime/i18n'
import { lookup } from '../runtime/i18n'
import { NEW_TAB_ATTRIBUTE } from '../runtime/outside'
import { KAY_ENGLISH, kayWord } from './words'

const CSS_SPECIALS = /[\\"<\n\r\f\0]/g
const ESCAPED: Record<string, string> = { '\\': '\\\\', '"': '\\"', '<': '\\3C ', '\n': ' ', '\r': ' ', '\f': ' ', '\0': ' ' }

function styleOf(word: string): string {
  const text = word.replace(CSS_SPECIALS, character => ESCAPED[character]!)

  return `<style>a[${NEW_TAB_ATTRIBUTE}]::after{content:"${text}";position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}</style>`
}

// The rule saying aloud that a link kay opens in a new tab does: the text is the page's locale's `kay.link.newTab`, clipped out of sight as a screen reader still reads it. A page whose markup holds no such link, and whose islands and streamed parts can add none, goes without it.
export function newTabRule(markup: string, mayGainLinks: boolean, sameTab: boolean): string {
  if (sameTab || !(mayGainLinks || markup.includes(` ${NEW_TAB_ATTRIBUTE}`)))
    return ''

  return styleOf(kayWord('kay.link.newTab'))
}

// The css of the rule in each locale, which the style policy hashes at start so a strict `style-src` lets the inline rule through.
export function newTabStyles(translations: Iterable<Translations>): string[] {
  const styles = [...translations].map(locale => styleOf(lookup(locale, 'kay.link.newTab', {}) ?? KAY_ENGLISH['kay.link.newTab']))

  return [...new Set([styleOf(KAY_ENGLISH['kay.link.newTab']), ...styles])].map(style => style.slice('<style>'.length, -'</style>'.length))
}
