import { afterEach, expect, test } from 'bun:test'
import { mailLanguages } from '../src/mail'
import { setSiteLocale } from '../../../src/runtime/locale-state'

afterEach(() => {
  setSiteLocale('en')
})

test('writes mails in the site\'s locales, the default first, once the server knows them', () => {
  const languages = mailLanguages({})

  expect(languages.locales()).toEqual(['en'])

  setSiteLocale('fr', ['fr', 'en'])

  expect(languages.locales()).toEqual(['fr', 'en'])
  expect(Object.keys(languages.templates())).toEqual(['fr', 'en'])
  expect(languages.templates()).toBe(languages.templates())
})

test('keeps the locales the app gives over the site\'s', () => {
  setSiteLocale('fr', ['fr', 'en'])

  expect(mailLanguages({ locales: ['en', 'de'] }).locales()).toEqual(['en', 'de'])
  expect(mailLanguages({ locales: [] }).locales()).toEqual(['fr', 'en'])
})

test('writes English for a site locale kayjs-auth has no texts for', () => {
  setSiteLocale('pt', ['pt', 'xx-site-only', 'fr'])

  const templates = mailLanguages({}).templates()

  expect(Object.keys(templates)).toEqual(['pt', 'xx-site-only', 'fr'])
  expect(templates.pt).toEqual(templates['xx-site-only'])
  expect(templates['pt']!['verify-email']).toBe(mailLanguages({ locales: ['en'] }).templates().en!['verify-email'])
  expect(templates.fr!['verify-email']).not.toBe(templates.pt!['verify-email'])
})
