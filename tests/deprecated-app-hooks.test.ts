import type { CheckDiagnostic, CheckOptions } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { appHooks } from '../src/check/app-hooks'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

const check: (root: string, options: CheckOptions) => Promise<CheckDiagnostic[]> = appHooks

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: CheckDiagnostic[] }> {
  const root = await scratchDir('app-hooks-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await check(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-app-hooks', () => {
  it('writes onStart as onListen and moves observe.onError beside observe', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { onStart: () => undefined, observe: { serverTiming: true, onError: ({ error }) => report(error) } }\n',
      'a/kay.config.ts': 'export default { observe: { onError } }\n',
    })

    expect(found).toHaveLength(3)
    expect(text['kay.config.ts']).toBe('export default { onListen: () => undefined, onError: ({ error }) => report(error), observe: { serverTiming: true } }\n')
    expect(text['a/kay.config.ts']).toBe('export default { onError }\n')
  })

  it('writes the log group for \'json\' and a function written in place', async () => {
    const { text } = await fixed({
      'kay.config.ts': 'export default { observe: { log: \'json\' } }\n',
      'a/kay.config.ts': 'export default { observe: { log: entry => sink(entry), serverTiming: true } }\n',
      'b/kay.config.ts': 'export default { observe: { log: false } }\n',
    })

    expect(text['kay.config.ts']).toBe('export default { observe: { log: { format: \'json\' } } }\n')
    expect(text['a/kay.config.ts']).toBe('export default { observe: { log: { sink: entry => sink(entry) }, serverTiming: true } }\n')
    expect(text['b/kay.config.ts']).toBe('export default { observe: { log: false } }\n')
  })

  it('finds them in the options of pages() and testSite() and in their config', async () => {
    const { found, text } = await fixed({
      'src/server.ts': 'import { pages } from \'kay/server\'\n\nexport default pages({ root: import.meta.dir, onStart: () => undefined, config: { observe: { log: \'json\' } } })\n',
    })

    expect(found).toHaveLength(2)
    expect(text['src/server.ts']).toBe('import { pages } from \'kay/server\'\n\nexport default pages({ root: import.meta.dir, onListen: () => undefined, config: { observe: { log: { format: \'json\' } } } })\n')
  })

  it('reports with no fix where the new key is written, a comment is in the way or the value is held elsewhere', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { onListen: a, onStart: b, onError: c, observe: { serverTiming: true, onError: d } }\n',
      'a/kay.config.ts': 'export default { observe: { onError: d, /* kept */ serverTiming: true } }\n',
      'b/kay.config.ts': 'const log = \'json\'\nexport default { observe: { log } }\n',
    })

    expect(found).toHaveLength(3)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
    expect(text['kay.config.ts']).toContain('onStart: b')
  })

  it('leaves the new forms, other files and a job\'s onStart alone', async () => {
    const { found } = await fixed({
      'kay.config.ts': 'export default { onListen: () => undefined, onError: () => undefined, observe: { log: { format: \'json\' } } }\n',
      'src/jobs.ts': 'export default { onStart: () => undefined, observe: { onError: 1 } }\n',
    })

    expect(found).toEqual([])
  })
})
