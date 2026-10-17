import { join } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
const WORD = /\bword\('([\w.]+)'/g
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
