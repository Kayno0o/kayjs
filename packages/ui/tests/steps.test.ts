import { describe, expect, it } from 'bun:test'
import { currentStep, stepDraft, stepHref } from '../src/steps'

const KEYS = ['account', 'details', 'review']

function jar(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial))

  return {
    held,
    get: (name: string) => held.get(name),
    set: (name: string, value: string) => void held.set(name, value),
    delete: (name: string) => void held.delete(name),
  }
}

describe('stepHref', () => {
  it('sets the step and keeps the other params, dropping the hash', () => {
    expect(stepHref('/signup?plan=pro&step=account#top', 'details')).toBe('/signup?plan=pro&step=details')
    expect(stepHref(new URL('https://kaynooo.fr/signup'), 'review', 'at')).toBe('/signup?at=review')
  })
})

describe('currentStep', () => {
  it('shows the step the URL names when it is done or the first open one', () => {
    expect(currentStep('/s?step=account', KEYS, ['account'])).toBe('account')
    expect(currentStep('/s?step=details', KEYS, ['account'])).toBe('details')
  })

  it('refuses a step past the first open one, and an unknown or missing one', () => {
    expect(currentStep('/s?step=review', KEYS, ['account'])).toBe('details')
    expect(currentStep('/s?step=review', KEYS)).toBe('account')
    expect(currentStep('/s?step=nope', KEYS, ['account'])).toBe('details')
    expect(currentStep('/s', KEYS)).toBe('account')
  })

  it('stays on the last step once every step is done', () => {
    expect(currentStep('/s?step=review', KEYS, KEYS)).toBe('review')
    expect(currentStep('/s', KEYS, KEYS)).toBe('review')
  })
})

describe('stepDraft', () => {
  it('keeps each step\'s values across posts and merges them', () => {
    const cookies = jar()

    stepDraft(cookies, 'signup').save('account', { email: 'a@b.fr' })
    stepDraft(cookies, 'signup').save('details', { name: 'Ada', email: 'c@d.fr' })

    const draft = stepDraft(cookies, 'signup')

    expect(draft.done()).toEqual(['account', 'details'])
    expect(draft.merged()).toEqual({ email: 'c@d.fr', name: 'Ada' })
  })

  it('leaves out a step whose values fail the check, as an edited cookie would', () => {
    const cookies = jar()

    stepDraft(cookies, 'signup').save('account', { email: 'nope' })

    const draft = stepDraft(cookies, 'signup', { check: (_, values) => String(values.email).includes('@') })

    expect(draft.done()).toEqual([])
    expect(draft.values()).toEqual({})
  })

  it('reads a broken or foreign cookie as empty, and clears', () => {
    const cookies = jar({ ksteps_signup: '{bad' })

    expect(stepDraft(cookies, 'signup').done()).toEqual([])

    cookies.held.set('ksteps_signup', '[1]')

    expect(stepDraft(cookies, 'signup').done()).toEqual([])

    stepDraft(cookies, 'signup').save('account', { a: 1 })
    stepDraft(cookies, 'signup').clear()

    expect(cookies.held.size).toBe(0)
  })

  it('refuses a draft too big for a cookie', () => {
    expect(() => stepDraft(jar(), 'signup').save('account', { bio: 'x'.repeat(4000) })).toThrow(RangeError)
  })
})

describe('stepDraft on a Bun.CookieMap', () => {
  it('round-trips through the request\'s cookie map and clears', () => {
    const cookies = new Bun.CookieMap()
    const draft = stepDraft(cookies, 'signup')

    draft.save('account', { email: 'a@b.fr' })

    expect(stepDraft(cookies, 'signup').merged()).toEqual({ email: 'a@b.fr' })

    draft.clear()

    expect(stepDraft(cookies, 'signup').done()).toEqual([])
  })
})
