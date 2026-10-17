import type { Action } from '../src/runtime'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { messageProblems } from '../src/check/messages'
import { wording } from '../src/runtime/words.server'
import { testSite } from '../src/test'

const FIXTURE = 'tests/fixtures/kay-words'
const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` }
const site = await testSite({ routes: `${FIXTURE}/src/routes`, i18n, bodyLimit: 1024 * 1024 })
const { check, guarded, owned, boom } = await import(join(import.meta.dir, 'fixtures/kay-words/src/routes/index.kay')) as {
  check: Action<Record<string, string>, unknown>
  guarded: Action<Record<string, string>, unknown, 'website'>
  owned: Action<Record<string, string>, unknown, 'website'>
  boom: Action<Record<string, never>, unknown>
}

const REFUSED = { name: 'ab', nick: 'abcd', code: 'y', age: '3' }

describe('kay\'s refusals in the app\'s catalogs', () => {
  it('words a schema refusal by its kind with the limit filled in, and leaves a kind without a key and a field\'s own error as they were', async () => {
    const french = await site.submit(check, REFUSED, { from: '/fr' })

    expect(french.status).toBe(422)
    expect(french.html).toContain('Au moins 3 caractères')
    expect(french.html).toContain('Au plus 2 caractères')
    expect(french.html).toContain('18 ou plus')
    expect(french.html).toContain('Champ requis')
    expect(french.html).toContain('Expected string to match')
    expect(french.html).toContain('Mine')
  })

  it('shows Elysia\'s wording on a site whose catalogs have no kay keys', async () => {
    const english = await site.submit(check, REFUSED, { from: '/' })

    expect(english.html).toContain('Expected string length greater or equal to 3')
    expect(english.html).toContain('Expected string length less or equal to 2')
    expect(english.html).toContain('Property \'age\'')
    expect(english.html).not.toContain('ou plus')
    expect(english.html).not.toContain('Champ requis')
  })

  it('words the honeypot and the rate limit, and a per-action message wins over the catalog', async () => {
    const english = await site.submit(guarded, { website: 'spam' }, { from: '/' })
    const french = await site.submit(guarded, { website: 'spam' }, { from: '/fr' })
    const own = await site.submit(owned, { website: 'spam' }, { from: '/fr' })

    expect(english.html).toContain('Leave this field empty')
    expect(french.html).toContain('Laissez ce champ vide')
    expect(own.html).toContain('Own words')
    expect(own.html).not.toContain('Laissez')
  })

  it('words the rate limit with the wait and the body limit with the size', async () => {
    await site.submit(guarded, {}, { from: '/fr' })

    const limited = await site.submit(guarded, {}, { from: '/fr' })
    const large = await site.submit(guarded, { website: '', filler: 'x'.repeat(2000) }, { from: '/fr' })

    expect(limited.status).toBe(429)
    expect(limited.html).toMatch(/Trop d(&#39;|&#x27;|')essais, réessayez dans \d+ s/)
    expect(large.html).toContain('Trop volumineux, 200 bytes au plus')
  })

  it('words the server error when a handler throws', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const english = await site.submit(boom, {}, { from: '/' })
      const french = await site.submit(boom, {}, { from: '/fr' })

      expect(english.html).toContain('Something went wrong on our side; try again later')
      expect(french.html).toContain('Une erreur est survenue de notre côté')
    }
    finally {
      error.mockRestore()
    }
  })
})

describe('kay check on the catalogs', () => {
  it('lets a locale word the kay.* keys the default locale does not give', async () => {
    expect(await messageProblems(process.cwd(), { ...i18n, messages: `${FIXTURE}/src/messages` })).toEqual([])
  })
})

describe('wording', () => {
  it('is the English with its placeholders filled outside a request', () => {
    expect(wording('kay.none', 'Up to {max} of {n}', { max: 5, n: 'a' })).toBe('Up to 5 of a')
    expect(wording('kay.none', 'Go to {n}')).toBe('Go to {n}')
  })
})
