import { join } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
const WORD = /\bwording\('ai\.([\w.]+)'/g

test('the French catalog the library ships words every ai.* key the chat looks up, and no other', async () => {
  const keys = new Set<string>()

  for (const path of await Array.fromAsync(new Bun.Glob('src/**/*.{kay,ts}').scan({ cwd: ROOT }))) {
    for (const [, key] of (await Bun.file(join(ROOT, path)).text()).matchAll(WORD))
      keys.add(key!)
  }

  const { default: french } = await import('../src/messages/fr') as { default: { ai: Record<string, Record<string, unknown>> } }
  const worded = Object.entries(french.ai).flatMap(([area, names]) => Object.keys(names).map(name => `${area}.${name}`))

  expect(worded.toSorted()).toEqual([...keys].toSorted())
})
