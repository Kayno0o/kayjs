import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const root = join(import.meta.dir, '..')
const SOURCES = ['src/**/*.{ts,kay}', 'packages/*/src/**/*.{ts,kay}']
// A constant naming a cookie or a storage key, and the literal names handed to the cookie calls.
const NAMED = /\b(?:const|let)\s+\w*(?:COOKIE|HINT|STORAGE_KEY|SIGNED_IN|PREFIX)\w*(?::[^=\n]+)? ?=\s*'([^']+)'/g
const CALLED = /(?:new Bun\.Cookie|cookies\.set)\(\s*'([^']+)'/g
// The value a constant such as `kay_analytics=yes` adds to the cookie's name.
const VALUE = /=.*/
// Names built from a template or by a helper, which no pattern above sees.
const BUILT = ['ksteps_', 'kcms:draft:', 'kcms:rebuilding', 'kcms-editor', 'kay_editor-refused', 'kay_session', 'kay-w', 'remember', 'listWidthKey']

async function sourceFiles(): Promise<string[]> {
  const found: string[] = []

  for (const pattern of SOURCES) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
      if (!file.includes('/node_modules/') && !file.includes('.test.'))
        found.push(file)
    }
  }

  return found.toSorted()
}

async function storedNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  for (const file of await sourceFiles()) {
    const text = await Bun.file(join(root, file)).text()

    for (const match of [...text.matchAll(NAMED), ...text.matchAll(CALLED)]) {
      const name = match[1]!.replace(VALUE, '')

      // The prefixes of a message key or a table are not storage.
      if ((/^(?:kay_|ksteps_|kcms|kay-)/).test(name) || (/COOKIE|HINT|STORAGE/).test(match[0]))
        names.set(name, file)
    }
  }

  for (const name of BUILT)
    names.set(name, 'built')

  return names
}

describe('the privacy pages name every cookie and storage key', () => {
  it('finds the cookies and keys the sources set', async () => {
    const names = [...(await storedNames()).keys()]

    expect(names).toEqual(expect.arrayContaining(['kay_flash', 'kay_locale', 'kay_preview', 'kay_analytics', 'kay_user', 'kay_editor', 'kay_editor_session', 'kay-reloaded']))
  })

  for (const [label, file] of [['llms/privacy.md', 'llms/privacy.md'], ['the docs privacy page', 'docs/src/content/docs/guides/privacy.md']] as const) {
    it(`${label} lists each one`, async () => {
      const page = await Bun.file(join(root, file)).text()
      const missing = [...await storedNames()].filter(([name]) => !new RegExp(`${RegExp.escape(name)}(?![\\w-])`).test(page)).map(([name, from]) => `${name} (${from})`)

      expect(missing).toEqual([])
    })
  }
})
