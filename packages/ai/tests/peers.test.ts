import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const SRC = new Glob('src/**/*.{ts,kay}')

// An app calling `ask()` alone installs no kayjs-ui, Tailwind or icon set, so kayjs-ui is an optional peer that only the chat files import.
test('kayjs-ui is an optional peer, imported by the chat files alone', async () => {
  const manifest = await Bun.file('package.json').json() as { peerDependencies: Record<string, string>, peerDependenciesMeta?: Record<string, unknown> }

  expect(manifest.peerDependencies['@kaynooo/kayjs-ui']).toBeDefined()
  expect(manifest.peerDependenciesMeta?.['@kaynooo/kayjs-ui']).toEqual({ optional: true })

  const importers: string[] = []

  for (const file of await Array.fromAsync(SRC.scan())) {
    if ((await Bun.file(file).text()).includes('@kaynooo/kayjs-ui'))
      importers.push(file)
  }

  expect(importers.sort()).toEqual(['src/chat.kay'])
})
