import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'
import { lookup } from '../src/runtime/i18n'
import { implicitI18n, loadI18n } from '../src/server/i18n'
import { scratchDir } from './scratch'

const MESSAGES = (tree: string) => `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${tree})\n`

// An app installing `kay-lib`, whose package.json declares a catalog of `fr.ts` alone, and `plain-lib`, which declares none.
async function project(config: string, own: Record<string, string> = {}): Promise<string> {
  const root = await scratchDir('library-messages-')

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { 'kay-lib': '*', 'plain-lib': '*' } }),
    'kay.config.ts': config,
    'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', kay: { messages: './messages' }, peerDependencies: { kay: '*' } }),
    'node_modules/kay-lib/messages/fr.ts': MESSAGES('{ lib: { cancel: \'Annuler\', title: \'Titre\', rows: { one: \'{count} ligne\', other: \'{count} lignes\' } } }'),
    'node_modules/plain-lib/package.json': JSON.stringify({ name: 'plain-lib', peerDependencies: { kay: '*' } }),
    ...own,
  }

  await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(root, path), text)))

  return root
}

describe('a library\'s message catalog, declared in its package.json', () => {
  const sites: Record<string, string> = {}

  beforeAll(async () => {
    sites.french = await project('export default { lang: \'fr\' }\n')
    sites.own = await project('export default { lang: \'fr\' }\n', { 'src/messages/fr.ts': MESSAGES('{ lib: { title: \'Mon titre\' } }') })
    sites.english = await project('export default {}\n')
    sites.regional = await project('export default { lang: \'fr-CA\' }\n')
    sites.listed = await project('export default { lang: \'fr\', extensions: [{ name: \'kay-lib\', messages: \'./mine\' }] }\n', { 'mine/fr.ts': MESSAGES('{ lib: { cancel: \'Laisser\' } }') })
  })

  test('is listed as an extension of the app with no line in its config, the libraries without one left out', async () => {
    const { extensions } = await loadConfig(sites.french!)

    expect(extensions?.map(({ name }) => name)).toEqual(['kay-lib'])
  })

  test('gives a site on one French locale and no src/messages its texts, plurals included', async () => {
    const { translations } = await implicitI18n(sites.french!, 'fr', (await loadConfig(sites.french!)).extensions)
    const fr = translations.get('fr')!

    expect(lookup(fr, 'lib.cancel')).toBe('Annuler')
    expect(lookup(fr, 'lib.rows', { count: 1 })).toBe('1 ligne')
    expect(lookup(fr, 'lib.rows', { count: 3 })).toBe('3 lignes')
  })

  test('leaves the app\'s own key the winner and a key it lacks to the library', async () => {
    const { translations } = await implicitI18n(sites.own!, 'fr', (await loadConfig(sites.own!)).extensions)
    const fr = translations.get('fr')!

    expect(lookup(fr, 'lib.title')).toBe('Mon titre')
    expect(lookup(fr, 'lib.cancel')).toBe('Annuler')
  })

  test('leaves a locale it has no file for to the English, with no catalog to read', async () => {
    const { translations } = await implicitI18n(sites.english!, 'en', (await loadConfig(sites.english!)).extensions)

    expect(lookup(translations.get('en')!, 'lib.cancel')).toBeUndefined()
  })

  test('is read for a regional locale through its language', async () => {
    const { translations } = await implicitI18n(sites.regional!, 'fr-CA', (await loadConfig(sites.regional!)).extensions)

    expect(lookup(translations.get('fr-CA')!, 'lib.cancel')).toBe('Annuler')
  })

  test('stands down for an extension of the same name the app lists itself', async () => {
    const { extensions } = await loadConfig(sites.listed!)
    const { translations } = await implicitI18n(sites.listed!, 'fr', extensions)

    expect(extensions).toHaveLength(1)
    expect(lookup(translations.get('fr')!, 'lib.cancel')).toBe('Laisser')
  })

  test('serves a site in two locales whose default has no catalog of the library\'s', async () => {
    const root = await project('export default { i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n', { 'src/messages/en.ts': MESSAGES('{ home: \'Home\' }') })
    const { translations } = await loadI18n(root, { locales: ['en', 'fr'], defaultLocale: 'en' }, (await loadConfig(root)).extensions)

    expect(lookup(translations.get('fr')!, 'lib.cancel')).toBe('Annuler')
    expect(lookup(translations.get('en')!, 'lib.cancel')).toBeUndefined()
  })
})
