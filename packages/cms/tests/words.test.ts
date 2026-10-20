import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { AFTER_LOAD } from '../src/editor/words'
import { emptyFile, tooLarge, tooLargeForServer } from '../src/upload-text'

const SRC = join(import.meta.dir, '../src')
const KEY = /wording\(\s*'(cms\.[A-Za-z.]+)'/g
// The files the editor runs in once the page has loaded, whose keys no island's own source names.
const AFTER_LOAD_FILES = ['components/entry-body.kay', 'components/entry-notices.kay', 'editor/datetime-input.kay', 'editor/entry-fields.kay', 'editor/entry-form.kay', 'editor/field-input.kay', 'editor/file-input.kay', 'editor/reorder.kay', 'editor/save.ts', 'editor/upload.ts', 'upload-text.ts', 'fields.ts']

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

describe('the upload refusals, with no catalog', () => {
  test('read as they always did', () => {
    expect(tooLarge('big.png', 100 * 1024, 64 * 1024)).toBe('big.png is 100 KB, over the 64 KB an upload may be')
    expect(tooLarge('', 1.5 * 1024 * 1024, 1024 * 1024)).toBe('The file is 1.5 MB, over the 1 MB an upload may be')
    expect(tooLarge('tiny', 900, 512)).toBe('tiny is 900 bytes, over the 512 bytes an upload may be')
    expect(tooLargeForServer('big.png', 2 * 1024 * 1024)).toBe('big.png is 2 MB, over what an upload may be')
    expect(emptyFile('')).toBe('The file is empty')
  })
})
