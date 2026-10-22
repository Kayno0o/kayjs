import { describe, expect, it } from 'bun:test'
import { currentStep, stepDraft, stepHref } from '../src/steps'

const KEYS = ['account', 'details', 'review']
const ANY = { check: () => true }

function jar(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial))

  return {
    held,
    get: (name: string) => held.get(name),
    options: [] as unknown[],
    set(name: string, value: string, options?: unknown) {
      held.set(name, value)
      this.options.push(options)
    },
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

    stepDraft(cookies, 'signup', ANY).save('account', { email: 'a@b.fr' })
    stepDraft(cookies, 'signup', ANY).save('details', { name: 'Ada', email: 'c@d.fr' })

    const draft = stepDraft(cookies, 'signup', ANY)

    expect(draft.done()).toEqual(['account', 'details'])
    expect(draft.merged()).toEqual({ email: 'c@d.fr', name: 'Ada' })
  })

  it('leaves out a step whose values fail the check, as an edited cookie would', () => {
    const cookies = jar()

    stepDraft(cookies, 'signup', ANY).save('account', { email: 'nope' })

    const draft = stepDraft(cookies, 'signup', { check: (_, values) => String(values.email).includes('@') })

    expect(draft.done()).toEqual([])
    expect(draft.values()).toEqual({})
  })

  it('reads a broken or foreign cookie as empty, and clears', () => {
    const cookies = jar({ ksteps_signup: '{bad' })

    expect(stepDraft(cookies, 'signup', ANY).done()).toEqual([])

    cookies.held.set('ksteps_signup', '[1]')

    expect(stepDraft(cookies, 'signup', ANY).done()).toEqual([])

    stepDraft(cookies, 'signup', ANY).save('account', { a: 1 })
    stepDraft(cookies, 'signup', ANY).clear()

    expect(cookies.held.size).toBe(0)
  })

  it('counts a draft as the browser gets it, percent-encoded', () => {
    // Under 3,800 characters of JSON, over 3,800 bytes once encoded.
    const values = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, 'é']))

    expect(() => stepDraft(jar(), 'signup', ANY).save('account', values)).toThrow(RangeError)
  })

  it('drops keys that would reach the prototype, and a step kept as a list', () => {
    const cookies = jar({ ksteps_signup: '{"account":{"__proto__":{"admin":true},"email":"a@b.fr"},"details":[1]}' })
    const merged = stepDraft(cookies, 'signup', ANY).merged()

    expect(merged).toEqual({ email: 'a@b.fr' })
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect((merged as { admin?: boolean }).admin).toBeUndefined()
    expect(stepDraft(cookies, 'signup', ANY).done()).toEqual(['account'])
  })

  it('refuses a draft too big for a cookie', () => {
    expect(() => stepDraft(jar(), 'signup', ANY).save('account', { bio: 'x'.repeat(4000) })).toThrow(RangeError)
  })
})

describe('stepDraft cookie flags', () => {
  const saved = (options: Record<string, unknown>) => {
    const cookies = jar()

    stepDraft(cookies, 'signup', { ...ANY, ...options }).save('account', { email: 'a@b.fr' })

    return cookies.options[0] as { secure?: boolean }
  }

  it('is secure when the request is https, directly or behind a proxy', () => {
    expect(saved({ request: new Request('https://kaynooo.fr/signup') }).secure).toBe(true)
    expect(saved({ request: new Request('http://app/signup', { headers: { 'x-forwarded-proto': 'https' } }) }).secure).toBe(true)
  })

  it('is not secure over plain http, and an explicit secure wins', () => {
    expect(saved({ request: new Request('http://localhost/signup') }).secure).toBe(false)
    expect(saved({}).secure).toBe(false)
    expect(saved({ request: new Request('https://kaynooo.fr/signup'), secure: false }).secure).toBe(false)
    expect(saved({ secure: true }).secure).toBe(true)
  })

  it('clears the draft a sign-out leaves behind, under the path it was saved to', () => {
    const cookies = jar()
    const draft = stepDraft(cookies, 'signup', { ...ANY, path: '/signup' })

    draft.save('account', { email: 'a@b.fr' })
    stepDraft(cookies, 'signup', { ...ANY, path: '/signup' }).clear()

    expect(cookies.held.size).toBe(0)
  })
})

describe('stepDraft on a Bun.CookieMap', () => {
  it('round-trips through the request\'s cookie map and clears', () => {
    const cookies = new Bun.CookieMap()
    const draft = stepDraft(cookies, 'signup', ANY)

    draft.save('account', { email: 'a@b.fr' })

    expect(stepDraft(cookies, 'signup', ANY).merged()).toEqual({ email: 'a@b.fr' })

    draft.clear()

    expect(stepDraft(cookies, 'signup', ANY).done()).toEqual([])
  })
})
