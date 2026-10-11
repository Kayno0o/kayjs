import { describe, expect, it } from 'bun:test'
import { cssColours } from '../src/css'

const SITE = new URL('fixture/src/styles/site.css', import.meta.url)

describe('cssColours', () => {
  const colour = cssColours(SITE)

  it('gives a custom property\'s first declaration as hex, its var()s and their fallbacks followed', () => {
    expect(colour('--color-brand')).toBe('#0047ff')
    expect(colour('--color-paper')).toBe('#ffffff')
    expect(colour('--color-ink')).toMatch(/^#[\da-f]{6}$/)
  })

  it('names a property missing, no colour, seen through or referring to itself', () => {
    expect(() => colour('--color-wine')).toThrow(`--color-wine is not declared in ${SITE.pathname}`)
    expect(() => colour('--space')).toThrow('--space in')
    expect(() => colour('--space')).toThrow('is 12px, which is no colour')
    expect(() => colour('--color-shade')).toThrow('a colour seen through')
    expect(() => colour('--loop-a')).toThrow('--loop-a -> --loop-b -> --loop-a in')
  })

  it('names a stylesheet it cannot read, as a compiled server has none', () => {
    expect(() => cssColours('/nowhere/site.css')).toThrow('the mail settings take their colours from /nowhere/site.css, which cannot be read')
  })
})
