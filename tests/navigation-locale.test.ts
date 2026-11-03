import type { LocaleSettings } from '../src/runtime/i18n'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { importsNavigate } from '../src/build/navigation-locale'

const SETTINGS: LocaleSettings = { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false, pages: ['/', '/second'] }

let links: typeof import('../src/runtime/i18n-links')
let i18n: typeof import('../src/runtime/i18n')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/fr/' })
  links = await import('../src/runtime/i18n-links')
  i18n = await import('../src/runtime/i18n')
  links.noteLinkPayload({ locale: 'fr', settings: SETTINGS })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// What `navigate(path)` goes to on a French page: the localizer `kay/i18n-links` hands it.
describe('the path navigate() localizes', () => {
  it.each([
    ['/second', '/fr/second'],
    ['/second?x=1#top', '/fr/second?x=1#top'],
    ['/fr/second', '/fr/second'],
    ['/en/second', '/en/second'],
    ['https://other.example/second', 'https://other.example/second'],
    ['//other.example/second', '//other.example/second'],
    ['?q=1', '?q=1'],
    ['#top', '#top'],
  ])('sends %s to %s', (path, expected) => {
    expect(links.localizedHref(path)).toBe(expected)
  })

  it('leaves a path as written when locales go by domain', () => {
    const hosts: LocaleSettings = { ...SETTINGS, hosts: { en: 'en.example', fr: 'fr.example' } }

    expect(i18n.localizedLink(hosts, '/second', 'fr', 'fr.example')).toBe('/second')
  })
})

describe('the modules that import navigate', () => {
  it.each([
    'import { navigate } from \'kay\'',
    'import { refresh, navigate as go } from "kay"',
    'import * as kay from \'kay\'',
  ])('are found by %s', (line) => {
    expect(importsNavigate(`${line}\ngo()`)).toBe(true)
  })

  it.each([
    'import { refresh } from \'kay\'',
    'import type { navigate } from \'kay\'',
    'import { navigate } from \'./navigate\'',
    'const navigate = () => undefined',
  ])('are not found by %s', (line) => {
    expect(importsNavigate(line)).toBe(false)
  })
})
