import { extname } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { kayFileIsShared } from '../src/test/shared-modules'

const STRING = /(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g

// No test here registers a DOM, so the names happy-dom adds are not yet in globalThis.
describe('the files of kay the test shares with a mounted component', () => {
  it('shares no file of kay that uses a class the DOM adds', async () => {
    const { Window } = await import('happy-dom')
    const page = new Window() as unknown as Record<string, unknown>
    const added = Object.getOwnPropertyNames(page).filter(name => (/^[A-Z]\w+$/).test(name) && !(name in globalThis) && typeof page[name] === 'function')

    expect(added).toContain('HTMLElement')

    const pattern = new RegExp(`(?<![\\w$.])(?:${added.join('|')})(?![\\w$])`)
    const transpilers = { '.ts': new Bun.Transpiler({ loader: 'ts' }), '.tsx': new Bun.Transpiler({ loader: 'tsx' }) }
    const offenders: string[] = []

    for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: 'src', absolute: true })) {
      // The runtime code alone: a type naming `HTMLFormElement` is erased, and comments and strings do not read the page.
      const code = transpilers[extname(file) as '.ts' | '.tsx'].transformSync(await Bun.file(file).text()).replace(STRING, '""')
      const found = pattern.exec(code)

      if (found && kayFileIsShared(file))
        offenders.push(`${file}: ${found[0]}`)
    }

    expect(offenders).toEqual([])
  })
})
