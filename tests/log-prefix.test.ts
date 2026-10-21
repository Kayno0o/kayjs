import { join } from 'node:path'
import { expect, it } from 'bun:test'

const ROOT = join(import.meta.dir, '..')

// `kayLog` heads a message with `kay:` and a library's `logFrom('kayjs-x')` with `kayjs-x:`, so a message that opens with its own head reads `kay: kay: ...`.
const HEAD = /\b(?:kayLog\(\s*'(?:info|warn|error)',|log\.(?:info|warn|error)\()\s*[`'"]((?:kay|kayjs-[a-z]+):)/g

it('no log message opens with the head its logger writes', async () => {
  const doubled: string[] = []

  for (const file of [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT }), ...new Bun.Glob('packages/*/src/**/*.{ts,kay}').scanSync({ cwd: ROOT })]) {
    const text = await Bun.file(join(ROOT, file)).text()

    for (const match of text.matchAll(HEAD)) {
      const line = text.slice(0, match.index).split('\n').length

      doubled.push(`${file}:${line} ${match[1]}`)
    }
  }

  expect(doubled).toEqual([])
})
