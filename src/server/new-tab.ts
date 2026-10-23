import { NEW_TAB_ATTRIBUTE } from '../runtime/outside'
import { kayWord } from './words'

const CSS_SPECIALS = /[\\"<\n\r]/g
const ESCAPED: Record<string, string> = { '\\': '\\\\', '"': '\\"', '<': '\\3C ', '\n': ' ', '\r': ' ' }

// The rule saying aloud that a link kay opens in a new tab does: the text is the page's locale's `kay.link.newTab`, clipped out of sight as a screen reader still reads it. A page whose markup holds no such link, and whose islands and streamed parts can add none, goes without it.
export function newTabRule(markup: string, mayGainLinks: boolean, sameTab: boolean): string {
  if (sameTab || !(mayGainLinks || markup.includes(` ${NEW_TAB_ATTRIBUTE}`)))
    return ''

  const text = kayWord('kay.link.newTab').replace(CSS_SPECIALS, character => ESCAPED[character]!)

  return `<style>a[${NEW_TAB_ATTRIBUTE}]::after{content:"${text}";position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}</style>`
}
