import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedConfigKeys } from '../src/check/deprecated-config-keys'
import { applySafeFixes } from '../src/check/fixes'
import { mergeConfig } from '../src/config-loader'
import { GROUPED_KEYS, groupedKeys, mergeBags, unknownConfigKeys } from '../src/config-shape'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('config-keys-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('the config keys of before 1.88', () => {
  it('names the key that replaced a removed one', () => {
    expect(unknownConfigKeys({ routes: 'a', api: 'b', content: 'c', storage: 'd', maxSizes: {}, settings: {} })).toEqual(['`routes`, did you mean `dirs.routes`?', '`api`, did you mean `dirs.api`?', '`content`, did you mean `contentConfig`?', '`storage`, did you mean `store.files`?', '`maxSizes`, did you mean `limits.byPath`?', '`settings`, did you mean `librarySettings`?'])
    expect(unknownConfigKeys({ routesDir: 'a', apiDir: 'b' })).toEqual([])
    expect(unknownConfigKeys({ routsDir: 'a', setting: {}, maxSize: 1, contnt: 'x' })).toEqual(['`routsDir`, did you mean `dirs.routes`?', '`setting`', '`contnt`'])
  })

  it('reads no removed key', () => {
    expect(groupedKeys<object>({ routes: 'a', storage: 'b' })).toEqual({ routes: 'a', storage: 'b' })
  })
})

describe('deprecated-file-store', () => {
  it('reports fileStore in the config, pages() and testSite(), and --fix moves its value under store.files unless a store is written beside it', async () => {
    const config = 'import { defineConfig, diskFiles } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  fileStore: diskFiles(\'data/files\'),\n})\n'
    const shorthand = 'import { testSite } from \'kay/test\'\n\nconst fileStore = undefined\nexport const site = testSite({ fileStore })\n'
    const beside = 'import { pages, sqliteData } from \'kay/server\'\n\nexport const app = pages({ store: sqliteData(\'data/app.sqlite\'), fileStore: undefined })\n'
    const other = 'import { pages } from \'./mine\'\n\nexport const x = pages({ fileStore: 1 })\nexport const files = { fileStore: 1 }\n'
    const spread = 'import { pages } from \'kay/server\'\n\nconst base = {}\nexport const a = pages({ ...base, fileStore: undefined })\nexport const b = pages({ [\'store\']: undefined, fileStore: undefined })\n'
    const root = await project({ 'kay.config.ts': config, 'src/site.ts': shorthand, 'src/server.ts': beside, 'src/other.ts': other, 'src/spread.ts': spread })

    try {
      const found = await deprecatedConfigKeys(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.code, diagnostic.fixes === undefined]).sort()).toEqual([
        ['kay.config.ts', 'deprecated-file-store', false],
        ['src/server.ts', 'deprecated-file-store', true],
        ['src/site.ts', 'deprecated-file-store', false],
        ['src/spread.ts', 'deprecated-file-store', true],
        ['src/spread.ts', 'deprecated-file-store', true],
      ])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config.replace('fileStore: diskFiles(\'data/files\')', 'store: { files: diskFiles(\'data/files\') }'))
      expect(await Bun.file(join(root, 'src/site.ts')).text()).toBe(shorthand.replace('{ fileStore }', '{ store: { files: fileStore } }'))
      expect(await Bun.file(join(root, 'src/server.ts')).text()).toBe(beside)
      expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe(other)
      expect(await Bun.file(join(root, 'src/spread.ts')).text()).toBe(spread)
      expect((await deprecatedConfigKeys(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1)).filter(file => file !== 'src/spread.ts')).toEqual(['src/server.ts'])
      expect(await deprecatedConfigKeys(root, { lints: { 'deprecated-file-store': 'allow', 'deprecated-config-groups': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the deprecated keys beyond pages() and testSite() by name', () => {
  it('follows an import under another name or a namespace, and reads an extension\'s config', async () => {
    const aliased = 'import { pages as serve } from \'kay/server\'\n\nexport const a = serve({ compress: false })\n'
    const namespaced = 'import * as kay from \'kay/server\'\n\nexport const b = kay.pages({ fileStore: undefined })\n'
    const extension = 'import type { KayExtension } from \'kay/server\'\n\nexport const lib: KayExtension = { name: \'lib\', config: { log: false, lang: \'en\' } }\n'
    const unrelated = 'export const c = { config: { compress: 1 } }\nexport const d = { name: \'x\', other: { compress: 1 } }\nexport const e = { name: \'job\', config: { fileStore: {}, compress: 1 } }\n'
    const root = await project({ 'src/a.ts': aliased, 'src/b.ts': namespaced, 'src/lib.ts': extension, 'src/c.ts': unrelated })

    try {
      const found = await deprecatedConfigKeys(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.code]).sort()).toEqual([['src/a.ts', 'deprecated-config-groups'], ['src/b.ts', 'deprecated-file-store'], ['src/lib.ts', 'deprecated-config-groups']])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(aliased.replace('{ compress: false }', '{ serve: { compress: false } }'))
      expect(await Bun.file(join(root, 'src/lib.ts')).text()).toBe(extension.replace('log: false', 'observe: { log: false }'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the grouped config keys', () => {
  it('moves each flat key into its bag, the bag winning when both are set, and leaves the rest alone', () => {
    expect(groupedKeys<object>({ routesDir: 'a', apiDir: 'b', publicDir: 'c', maxSize: '2mb', maxSizeByPath: { '/up': '9mb' }, apiPath: '/v1', compress: false, log: false, tracer: undefined, navigation: false, saveData: false, lang: 'en' })).toEqual({
      lang: 'en',
      dirs: { routes: 'a', api: 'b', public: 'c' },
      limits: { body: '2mb', byPath: { '/up': '9mb' } },
      serve: { apiPath: '/v1', compress: false },
      observe: { log: false, tracer: undefined },
      client: { navigation: false, saveData: false },
    })
    expect(groupedKeys<object>({ routesDir: 'old', dirs: { routes: 'new', api: 'x' } })).toEqual({ dirs: { routes: 'new', api: 'x' } })
    expect(groupedKeys<object>({ compress: false, serve: { compress: undefined, apiPath: '/v1' } })).toEqual({ serve: { compress: false, apiPath: '/v1' } })
    expect(groupedKeys<object>({ compress: false, serve: 'not a bag' })).toEqual({ serve: 'not a bag' })

    const untouched = { lang: 'en', dirs: { routes: 'a' } }

    expect(groupedKeys(untouched)).toBe(untouched)
  })

  it('names every flat key once, in a bag that takes it', () => {
    const bags = { dirs: ['routes', 'api', 'public'], limits: ['body', 'byPath'], serve: ['apiPath', 'compress', 'compressionDictionary', 'shutdownTimeout'], observe: ['log', 'serverTiming', 'requestIdHeader', 'tracer', 'onError'], client: ['navigation', 'inlineStyles', 'lateStyles', 'typography', 'hydration', 'prefetch', 'saveData'] }

    expect(Object.values(GROUPED_KEYS).every(([group, name]) => bags[group].includes(name))).toBe(true)
    expect(Object.values(GROUPED_KEYS).length).toBe(Object.values(bags).flat().length)
  })

  it('lays the options of a call over the config one bag deep, an undefined option leaving the config\'s value', () => {
    expect(mergeBags({ client: { navigation: true, prefetch: false }, dirs: { routes: 'a' }, lang: 'en' }, { client: { navigation: false, prefetch: undefined }, lang: undefined, minify: true })).toEqual({ client: { navigation: false, prefetch: false }, dirs: { routes: 'a' }, lang: 'en', minify: true })
    expect(mergeBags({ dirs: { routes: 'a' } }, { dirs: undefined })).toEqual({ dirs: { routes: 'a' } })
    expect(mergeBags({}, { serve: { compress: false } })).toEqual({ serve: { compress: false } })
  })

  it('checks the keys of each bag, and offers a flat key where it lives now', () => {
    expect(unknownConfigKeys({ dirs: { routes: 'a' }, limits: { body: 1 }, serve: { compress: true }, observe: { log: false }, client: { saveData: false } })).toEqual([])
    expect(unknownConfigKeys({ dirs: { route: 'a' }, client: { saveDat: false }, limits: { max: 1 } })).toEqual(['`dirs.route`, did you mean `dirs.routes`?', '`client.saveDat`, did you mean `client.saveData`?', '`limits.max`'])
    expect(unknownConfigKeys({ routsDir: 'a', compres: false })).toEqual(['`routsDir`, did you mean `dirs.routes`?', '`compres`, did you mean `serve.compress`?'])
  })
})

describe('deprecated-config-groups', () => {
  it('reports the flat keys of an object once, and --fix writes their bags where the first stood', async () => {
    const config = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  routesDir: \'src/pages\',\n  compress: false,\n  publicDir: \'static\',\n  navigation: false,\n  onError: ({ error }) => { console.error(error) },\n  minify: true,\n})\n'
    const last = 'import { pages } from \'kay/server\'\n\nconst apiPath = \'/v1\'\nexport const app = pages({ minify: true, apiPath, maxSize: \'2mb\', })\n'
    const only = 'import { testSite } from \'kay/test\'\n\nexport const site = testSite({ prefetch: false })\n'
    const beside = 'import { pages } from \'kay/server\'\n\nexport const app = pages({ serve: { compress: true }, compress: false, log: false })\n'
    const spread = 'import { pages } from \'kay/server\'\n\nconst base = {}\nexport const a = pages({ ...base, compress: false })\n'
    const other = 'import { pages } from \'./mine\'\n\nexport const x = pages({ compress: false })\nexport const routes = { log: 1 }\n'
    const root = await project({ 'kay.config.ts': config, 'src/server.ts': last, 'src/site.ts': only, 'src/beside.ts': beside, 'src/spread.ts': spread, 'src/other.ts': other })

    try {
      const found = (await deprecatedConfigKeys(root, {})).filter(diagnostic => diagnostic.code === 'deprecated-config-groups')

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.severity, diagnostic.fixes === undefined]).sort()).toEqual([
        ['kay.config.ts', 5, 'warning', false],
        ['src/beside.ts', 3, 'warning', true],
        ['src/server.ts', 4, 'warning', false],
        ['src/site.ts', 3, 'warning', false],
        ['src/spread.ts', 4, 'warning', true],
      ])
      expect(found.find(diagnostic => diagnostic.file.endsWith('kay.config.ts'))!.message).toBe('config keys are grouped by concern since 1.88, so a key is found by what it does: `routesDir` is `dirs.routes`, `compress` is `serve.compress`, `publicDir` is `dirs.public`, `navigation` is `client.navigation`, `onError` is `observe.onError`; the old keys work until 1.91')

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe('import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  dirs: { routes: \'src/pages\', public: \'static\' },\n  serve: { compress: false },\n  client: { navigation: false },\n  observe: { onError: ({ error }) => { console.error(error) } },\n  minify: true,\n})\n')
      expect(await Bun.file(join(root, 'src/server.ts')).text()).toBe('import { pages } from \'kay/server\'\n\nconst apiPath = \'/v1\'\nexport const app = pages({ minify: true, serve: { apiPath },\nlimits: { body: \'2mb\' }, })\n')
      expect(await Bun.file(join(root, 'src/site.ts')).text()).toBe('import { testSite } from \'kay/test\'\n\nexport const site = testSite({ client: { prefetch: false } })\n')
      expect(await Bun.file(join(root, 'src/beside.ts')).text()).toBe(beside)
      expect(await Bun.file(join(root, 'src/spread.ts')).text()).toBe(spread)
      expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe(other)
      expect((await deprecatedConfigKeys(root, {})).filter(diagnostic => diagnostic.code === 'deprecated-config-groups').map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/beside.ts', 'src/spread.ts'])
      expect(await deprecatedConfigKeys(root, { lints: { 'deprecated-config-groups': 'allow', 'deprecated-file-store': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the comments and the lines between the moved keys, and carries a key\'s own comment into its bag', async () => {
    const config = [
      'import { defineConfig } from \'kay/server\'',
      '',
      'export default defineConfig({',
      '  // the language',
      '  lang: \'en\',',
      '  routesDir: \'src/pages\', // where pages live',
      '  // kept: the site',
      '  site: \'https://x.example\',',
      '  compress: false, // keep it off',
      '  maxSize: \'2mb\', // upload limit',
      '  // kept: the minifier',
      '  minify: true,',
      '  onError: (error) => {',
      '    console.error(error)',
      '  },',
      '})',
      '',
    ].join('\n')
    const root = await project({ 'kay.config.ts': config })

    try {
      await applySafeFixes(root, await deprecatedConfigKeys(root, {}))
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe([
        'import { defineConfig } from \'kay/server\'',
        '',
        'export default defineConfig({',
        '  // the language',
        '  lang: \'en\',',
        '  dirs: {',
        '    routes: \'src/pages\', // where pages live',
        '  },',
        '  serve: {',
        '    compress: false, // keep it off',
        '  },',
        '  limits: {',
        '    body: \'2mb\', // upload limit',
        '  },',
        '  observe: {',
        '    onError: (error) => {',
        '    console.error(error)',
        '  },',
        '  },',
        '  // kept: the site',
        '  site: \'https://x.example\',',
        '  // kept: the minifier',
        '  minify: true,',
        '})',
        '',
      ].join('\n'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries the comments above a moved key into its bag, and a trailing comment of a multi-line value', async () => {
    const config = [
      'import { defineConfig } from \'kay/server\'',
      '',
      'export default defineConfig({',
      '  // the language',
      '  lang: \'en\',',
      '  // where pages live',
      '  /* and nothing else */',
      '  routesDir: \'src/pages\',',
      '',
      '  // the cache',
      '  compress: {',
      '    level: 3,',
      '  }, // keep it small',
      '  // upload limit',
      '  maxSize: \'2mb\',',
      '})',
      '',
    ].join('\n')
    const root = await project({ 'kay.config.ts': config })

    try {
      await applySafeFixes(root, await deprecatedConfigKeys(root, {}))
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe([
        'import { defineConfig } from \'kay/server\'',
        '',
        'export default defineConfig({',
        '  // the language',
        '  lang: \'en\',',
        '  dirs: {',
        '    // where pages live',
        '    /* and nothing else */',
        '    routes: \'src/pages\',',
        '  },',
        '  serve: {',
        '    // the cache',
        '    compress: {',
        '    level: 3,',
        '  }, // keep it small',
        '  },',
        '  limits: {',
        '    // upload limit',
        '    body: \'2mb\',',
        '  },',
        '',
        '})',
        '',
      ].join('\n'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the options of pages() and testSite()', () => {
  it('refuse a key kay removed, naming its replacement', () => {
    expect(() => mergeConfig({}, { storage: undefined, routes: 'a' } as never)).toThrow('`storage`, now `store.files`; `routes`, now `dirs.routes`')
    expect(mergeConfig({}, { dirs: { routes: 'a' } }).dirs).toEqual({ routes: 'a' })
  })
})
