import { describe, expect, it } from 'bun:test'
import { cssColours } from '../src/css'

const SITE = new URL('fixture/src/styles/site.css', import.meta.url)
const TEXT = await Bun.file(SITE).text()

describe('cssColours', () => {
  const colour = cssColours(TEXT, 'styles/site.css')

  it('gives a custom property\'s first declaration as hex, its var()s and their fallbacks followed, a selector holding its name aside', () => {
    expect(colour('--color-brand')).toBe('#0047ff')
    expect(colour('--color-paper')).toBe('#ffffff')
    expect(colour('--color-nested')).toBe('#0047ff')
    expect(colour('--color-ink')).toMatch(/^#[\da-f]{6}$/)
  })

  it('names a property missing, no colour, seen through or referring to itself, in the stylesheet named', () => {
    expect(() => colour('--color-wine')).toThrow('--color-wine is not declared in styles/site.css')
    expect(() => colour('--space')).toThrow('--space in styles/site.css is 12px, which is no colour')
    expect(() => colour('--color-shade')).toThrow('a colour seen through')
    expect(() => colour('--loop-a')).toThrow('--loop-a -> --loop-b -> --loop-a in styles/site.css refers to itself')
  })

  it('calls a text given no name the stylesheet', () => {
    expect(() => cssColours(':root { --space: 12px }')('--space')).toThrow('--space in the stylesheet is 12px, which is no colour')
  })

  it('reads the stylesheet a URL points at, naming its path', () => {
    expect(cssColours(SITE)('--color-brand')).toBe('#0047ff')
    expect(() => cssColours(SITE)('--color-wine')).toThrow(`--color-wine is not declared in ${SITE.pathname}`)
  })

  it('names a stylesheet it cannot read, as a compiled server has none, and the text import that works there', () => {
    expect(() => cssColours(new URL('file:///nowhere/site.css'))).toThrow('the mail settings take their colours from /nowhere/site.css, which cannot be read; a server built with `kay build --compile` carries no source file, so import the stylesheet\'s text with `with { type: \'text\' }` instead')
  })
})
