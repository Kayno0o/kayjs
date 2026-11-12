import type { LocaleSettings } from '../src/runtime/i18n'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { alternate as serverAlternate } from '../src/runtime/i18n.server'
import { runInLocale } from '../src/runtime/locale-state'
import { localeSettings, messagesScript } from '../src/server/i18n'

const settings: LocaleSettings = localeSettings({ locales: ['en', 'fr'], defaultLocale: 'en', messages: '' })
const entryUrls = new Map([['/blog/hello', { en: '/blog/hello', fr: '/blog/bonjour' }], ['/blog/other', { fr: '/blog/autre' }]])

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/app/blog/hello/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

it('gives an island the translated slug of the entry its page shows, as the server does', async () => {
  const state = { locale: 'en', messages: new Map(), settings, path: '/blog/hello/', entryUrls }
  const server = runInLocale(state, () => serverAlternate('fr'))
  const script = runInLocale(state, () => messagesScript(new Set(), true))

  expect(server).toBe('/fr/blog/bonjour')
  expect(script).not.toContain('/blog/autre')

  document.head.innerHTML = `<meta name="kay-base" content="/app">${script}`

  const { alternate } = await import('../src/runtime/i18n.client')

  expect(alternate('fr')).toBe(`/app${server}`)
  expect(alternate('en')).toBe('/app/blog/hello')
})

it('keeps the same slug for a page that showed no translated entry', () => {
  const state = { locale: 'en', messages: new Map(), settings, path: '/about' }

  expect(runInLocale(state, () => messagesScript(new Set(), true))).not.toContain('entryUrls')
})

it('follows a swap: no translated slug on a page without an entry, the new one on another entry page', async () => {
  const state = { locale: 'en', messages: new Map(), settings, path: '/blog/other', entryUrls }
  const scripts = (path: string) => runInLocale({ ...state, path }, () => messagesScript(new Set(), true))
  const { alternate } = await import('../src/runtime/i18n.client')

  history.pushState({}, '', '/app/about')
  document.head.innerHTML = `<meta name="kay-base" content="/app">${scripts('/about')}`
  expect(alternate('fr')).toBe('/app/fr/about')

  history.pushState({}, '', '/app/blog/other')
  document.head.innerHTML = `<meta name="kay-base" content="/app">${scripts('/blog/other')}`
  expect(alternate('fr')).toBe('/app/fr/blog/autre')

  // A swapped page with no payload of its own never takes the last page's entry.
  history.pushState({}, '', '/app/about')
  document.head.innerHTML = '<meta name="kay-base" content="/app">'
  expect(alternate('fr')).toBe('/app/fr/about')
})
