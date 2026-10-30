import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedConfigKeys } from '../src/check/deprecated-config-keys'
import { applySafeFixes } from '../src/check/fixes'
import { RENAMED_KEYS, renamedKeys, unknownConfigKeys } from '../src/config-shape'
import { localizedEntry, writeDraftEntry } from '../src/server/entry-drafts'
import { missingTranslations } from '../src/server/translations'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('config-keys-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('the renamed config keys', () => {
  it('moves each old key to its new name, the new name winning when both are set', () => {
    expect(renamedKeys<object>({ routes: 'a', api: 'b', content: 'c', storage: 'd', maxSizes: { '/x': 1 }, settings: { lib: 'e' }, lang: 'en' })).toEqual({ routesDir: 'a', apiDir: 'b', contentConfig: 'c', fileStore: 'd', maxSizeByPath: { '/x': 1 }, librarySettings: { lib: 'e' }, lang: 'en' })
    expect(renamedKeys<object>({ routes: 'old', routesDir: 'new' })).toEqual({ routesDir: 'new' })
    expect(renamedKeys<object>({ routes: undefined, routesDir: 'new' })).toEqual({ routesDir: 'new' })

    const untouched = { lang: 'en' }

    expect(renamedKeys(untouched)).toBe(untouched)
  })

  it('knows the old names as keys, and suggests the new ones only', () => {
    expect(unknownConfigKeys({ routes: 'a', apiDir: 'b' })).toEqual([])
    expect(unknownConfigKeys({ routsDir: 'a', storag: 'b' })).toEqual(['`routsDir`, did you mean `routesDir`?', '`storag`, did you mean `fileStore`?'])
    expect(unknownConfigKeys({ routs: 'a', setting: {}, maxSize: 1, contnt: 'x' })).toEqual(['`routs`, did you mean `routesDir`?', '`setting`, did you mean `librarySettings`?', '`contnt`, did you mean `contentConfig`?'])
    expect(Object.values(RENAMED_KEYS).every(name => !Object.hasOwn(RENAMED_KEYS, name))).toBe(true)
  })
})

describe('deprecated-config-keys', () => {
  it('reports an old key in kay.config.ts and in the options of pages() and testSite(), and --fix writes the new one', async () => {
    const config = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  routes: \'src/pages\',\n  \'api\': \'src/endpoints\',\n  lang: \'en\',\n  storage: undefined,\n})\n'
    const server = 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst content = \'src/c.ts\'\nexport const app = new Elysia().use(await pages({ content, maxSizes: { \'/up\': \'5mb\' }, settings: {} }))\n'
    const test = 'import { testSite } from \'kay/test\'\n\nexport const site = testSite({ routes: \'a\', routesDir: \'b\' })\n'
    const other = 'import { pages } from \'./mine\'\n\nexport const x = pages({ routes: 1 })\nexport const routes = { routes: 1 }\n'
    const root = await project({ 'kay.config.ts': config, 'src/server.ts': server, 'src/site.ts': test, 'src/other.ts': other })

    try {
      const found = await deprecatedConfigKeys(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.severity, diagnostic.fixes === undefined]).sort()).toEqual([
        ['kay.config.ts', 4, 'warning', false],
        ['kay.config.ts', 5, 'warning', false],
        ['kay.config.ts', 7, 'warning', false],
        ['src/server.ts', 5, 'warning', false],
        ['src/server.ts', 5, 'warning', false],
        ['src/server.ts', 5, 'warning', false],
        ['src/site.ts', 3, 'warning', true],
      ])
      expect(found.find(diagnostic => diagnostic.line === 4)!.message).toBe('`routes` is now `routesDir` in the config, so every directory key ends in `Dir` and no two keys differ by a letter; the old name works until 1.87')

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config.replace('routes:', 'routesDir:').replace('\'api\':', 'apiDir:').replace('storage:', 'fileStore:'))
      expect(await Bun.file(join(root, 'src/server.ts')).text()).toBe(server.replace('{ content, maxSizes: {', '{ contentConfig: content, maxSizeByPath: {').replace('settings: {}', 'librarySettings: {}'))
      expect(await Bun.file(join(root, 'src/site.ts')).text()).toBe(test)
      expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe(other)
      expect((await deprecatedConfigKeys(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1))).toEqual(['src/site.ts'])
      expect(await deprecatedConfigKeys(root, { lints: { 'deprecated-config-keys': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the library functions taking the config', () => {
  const i18n = { locales: ['en', 'fr'], defaultLocale: 'en' }

  it('read the content config under its old name', async () => {
    const messages = 'import { defineMessages } from \'kay\'\n\nexport default defineMessages({})\n'
    const root = await project({ 'src/messages/en.ts': messages, 'src/messages/fr.ts': messages })

    try {
      await expect(missingTranslations(root, { i18n, content: 'src/nope.ts' } as never)).rejects.toThrow('names src/nope.ts as the content config')
      await expect(localizedEntry(root, { i18n, content: 'src/nope.ts' } as never, 'news', 'a')).rejects.toThrow('names src/nope.ts as the content config')
      await expect(writeDraftEntry(root, { i18n, content: 'src/nope.ts' } as never, 'news', 'fr', 'a', { data: {} })).rejects.toThrow('names src/nope.ts as the content config')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-config-keys beyond pages() and testSite() by name', () => {
  it('follows an import under another name or a namespace, and reads an extension\'s config', async () => {
    const aliased = 'import { pages as serve } from \'kay/server\'\n\nexport const a = serve({ routes: \'x\' })\n'
    const namespaced = 'import * as kay from \'kay/server\'\n\nexport const b = kay.pages({ settings: {} })\n'
    const extension = 'export const lib = { name: \'lib\', config: { storage: undefined, lang: \'en\' } }\n'
    const unrelated = 'export const c = { config: { routes: 1 } }\nexport const d = { name: \'x\', other: { routes: 1 } }\nexport const e = { name: \'job\', config: { settings: {}, routes: 1 } }\n'
    const root = await project({ 'src/a.ts': aliased, 'src/b.ts': namespaced, 'src/lib.ts': extension, 'src/c.ts': unrelated })

    try {
      const found = await deprecatedConfigKeys(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.message.slice(0, diagnostic.message.indexOf(' '))]).sort()).toEqual([['src/a.ts', '`routes`'], ['src/b.ts', '`settings`'], ['src/lib.ts', '`storage`']])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(aliased.replace('routes', 'routesDir'))
      expect(await Bun.file(join(root, 'src/lib.ts')).text()).toBe(extension.replace('storage', 'fileStore'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
