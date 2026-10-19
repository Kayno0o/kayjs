import { join } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
const WORD = /\bwording\('ui\.([\w.]+)'/g
const LISTED = /`ui\.(\w+)\.\*`: (.*)/g
const PROP = /`(\w+)` \(/g

// Every `ui.*` key the components look up, from their sources.
async function used(): Promise<Set<string>> {
  const keys = new Set<string>()

  for (const path of await Array.fromAsync(new Bun.Glob('src/**/*.{kay,ts}').scan({ cwd: ROOT }))) {
    for (const [, key] of (await Bun.file(join(ROOT, path)).text()).matchAll(WORD))
      keys.add(key!)
  }

  return keys
}

test('the topic on texts and languages lists every key the components look up, and no other', async () => {
  const doc = await Bun.file(join(ROOT, 'llms/words.md')).text()
  const listed = new Set([...doc.matchAll(LISTED)].flatMap(([, component, props]) => [...props!.matchAll(PROP)].map(([, prop]) => `${component}.${prop}`)))

  expect([...listed].toSorted()).toEqual([...await used()].toSorted())
})

test('the French catalog the library ships words every key the components look up, with the placeholders and plural forms of the English', async () => {
  const { default: french } = await import('../src/messages/fr') as { default: { ui: Record<string, Record<string, unknown>> } }
  const keys = [...await used()]

  const worded = Object.entries(french.ui).flatMap(([component, props]) => Object.keys(props).map(prop => `${component}.${prop}`))

  expect(worded.toSorted()).toEqual(keys.toSorted())

  // A count's plural forms, as the English writes `{count}` in both of its texts.
  for (const [component, prop] of [['table', 'rowCount'], ['commandPalette', 'resultsLabel'], ['commandPalette', 'siteSearchMore'], ['multiSelect', 'selectedLabel'], ['table', 'selectedLabel']] as const) {
    const message = french.ui[component]![prop] as { one: string, other: string }

    expect(message.one).toContain('{count}')
    expect(message.other).toContain('{count}')
  }
})
