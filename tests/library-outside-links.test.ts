import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const PACKAGES = join(import.meta.dir, '..', 'packages')
const OPENS_APART = /_blank/
const NOREFERRER = /noreferrer/
const SHARED = /OUTSIDE|tabOf/
// Links whose `rel` comes from kay itself (its sanitizer and Markdown renderer write `nofollow ugc noopener` for every link leaving the site).
const KAY_WRITES_REL = new Set(['ai/src/chat-sources.kay', 'ai/src/chat-sources.ts', 'ai/src/chat.kay', 'cms/src/api/markdown.ts', 'ui/src/outside.ts'])

test('every link a library draws in a new tab by hand carries noopener noreferrer', async () => {
  const bare: string[] = []

  for await (const file of new Glob('*/src/**/*.{kay,ts}').scan(PACKAGES)) {
    if (KAY_WRITES_REL.has(file))
      continue

    const lines = (await Bun.file(join(PACKAGES, file)).text()).split('\n')

    for (const [index, line] of lines.entries()) {
      // The element's own line and the two after it, where a script sets `rel` after `target`.
      if (OPENS_APART.test(line) && !NOREFERRER.test(lines.slice(index, index + 3).join('\n')) && !SHARED.test(line))
        bare.push(`${file}:${index + 1}`)
    }
  }

  expect(bare).toEqual([])
})
