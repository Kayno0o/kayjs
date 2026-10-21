import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { AFTER_LOAD } from '../src/editor/words'
import { emptyFile, tooLarge, tooLargeForServer } from '../src/upload-text'

const SRC = join(import.meta.dir, '../src')
const KEY = /wording\(\s*'(cms\.[A-Za-z.]+)'/g
// The files the editor runs in once the page has loaded, whose keys no island's own source names.
const AFTER_LOAD_FILES = ['bulk-message.ts', 'components/entry-body.kay', 'components/entry-bulk.kay', 'components/entry-field.kay', 'components/entry-identity.kay', 'components/entry-notices.kay', 'components/entry-save-state.kay', 'components/reset-button.kay', 'components/session-ended.kay', 'editor/bulk.ts', 'editor/datetime-input.kay', 'editor/entry-fields.kay', 'editor/entry-form.kay', 'editor/field-input.kay', 'editor/file-input.kay', 'editor/ready-input.kay', 'editor/page-list-tools.kay', 'editor/page-lists.ts', 'editor/reorder.kay', 'editor/save.ts', 'editor/upload.ts', 'upload-text.ts', 'fields.ts']

async function keysOf(file: string): Promise<string[]> {
  return Array.from((await Bun.file(join(SRC, file)).text()).matchAll(KEY), match => match[1]!)
}

async function everyKey(): Promise<string[]> {
  const files = [...new Bun.Glob('**/*.{kay,ts}').scanSync({ cwd: SRC })]

  return [...new Set((await Promise.all(files.map(keysOf))).flat())].sort()
}

describe('the cms.* keys', () => {
  test('are all listed in llms/words.md, and it lists no other', async () => {
    const listed = await Bun.file(join(import.meta.dir, '../llms/words.md')).text()
    const documented = new Set(Array.from(listed.matchAll(/^- `cms\.(\w+)\.\*`: (.*)$/gm), ([, area, rest]) => Array.from(rest!.matchAll(/`(\w+)` \(/g), leaf => `cms.${area}.${leaf[1]}`)).flat())

    expect([...documented].sort()).toEqual(await everyKey())
  })

  test('are shipped with the editor for each one only read after the page loaded, and no other', async () => {
    const after = [...new Set((await Promise.all(AFTER_LOAD_FILES.map(keysOf))).flat())].sort()

    expect([...AFTER_LOAD]).toEqual(after)
  })
})

type Message = string | Record<string, string>

async function catalogOf(locale: string): Promise<Map<string, Message>> {
  const { default: catalog } = await import(`../src/messages/${locale}`) as { default: { cms: Record<string, Record<string, Message>> } }

  return new Map(Object.entries(catalog.cms).flatMap(([area, leaves]) => Object.entries(leaves).map(([leaf, message]) => [`cms.${area}.${leaf}`, message] as const)))
}

const placeholders = (text: string): string[] => Array.from(text.matchAll(/\{(\w+)\}/g), match => match[1]!)

// Every `src/messages/<locale>.ts` the package ships is held to the keys, so a new `cms.*` key without its text in one fails here.
const LOCALES = [...new Bun.Glob('*.ts').scanSync({ cwd: join(SRC, 'messages') })].map(file => file.replace(/\.ts$/, '')).sort()

describe.each(LOCALES)('the %s catalog the cms ships', (locale) => {
  test('words every cms.* key, and no other', async () => {
    expect([...(await catalogOf(locale)).keys()].sort()).toEqual(await everyKey())
  })

  test('holds the placeholders of the English, in each of its plural forms or none', async () => {
    const listed = await Bun.file(join(import.meta.dir, '../llms/words.md')).text()
    const english = new Map<string, string>()

    for (const [, area, rest] of listed.matchAll(/^- `cms\.(\w+)\.\*`: (.*)$/gm)) {
      for (const [, leaf, text] of rest!.matchAll(/`(\w+)` \(`([^`]*)`/g))
        english.set(`cms.${area}.${leaf}`, text!)
    }

    const catalog = await catalogOf(locale)

    // A text the topic describes in prose, with no literal English to compare.
    expect([...catalog.keys()].filter(key => !english.has(key))).toEqual(['cms.uploads.notice'])

    for (const [key, message] of catalog) {
      const wanted = english.get(key)

      if (wanted === undefined)
        continue

      const forms = typeof message === 'string' ? [message] : Object.values(message)

      expect({ key, placeholders: [...new Set(forms.flatMap(placeholders))].sort() }).toEqual({ key, placeholders: [...new Set(placeholders(wanted))].sort() })
    }
  })

  test('is declared by the package, so an app reads it with no setup', async () => {
    const { kay } = await Bun.file(join(import.meta.dir, '../package.json')).json() as { kay?: { messages?: string } }

    expect(kay?.messages).toBe('./src/messages')
  })
})

describe('the upload refusals, with no catalog', () => {
  test('read as they always did', () => {
    expect(tooLarge('big.png', 100 * 1024, 64 * 1024)).toBe('big.png is 100 KB, over the 64 KB an upload may be')
    expect(tooLarge('', 1.5 * 1024 * 1024, 1024 * 1024)).toBe('The file is 1.5 MB, over the 1 MB an upload may be')
    expect(tooLarge('tiny', 900, 512)).toBe('tiny is 900 bytes, over the 512 bytes an upload may be')
    expect(tooLargeForServer('big.png', 2 * 1024 * 1024)).toBe('big.png is 2 MB, over what an upload may be')
    expect(emptyFile('')).toBe('The file is empty')
  })
})
