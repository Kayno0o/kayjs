import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { serverOnlyImports } from '../src/compiler/fence-checks'
import { parseKay } from '../src/compiler/parser'
import { walkScope } from '../src/compiler/rewrite'
import { analyzeScript, analyzeServer, parseFence } from '../src/compiler/script'
import { semanticTokens } from '../src/lsp/semantic-tokens'

// An edit passes through a fence declaring one name twice, which Babel's scope refuses; the fence still compiles, and its tsgo error is the one reported.
const TWICE = ['---', 'import { open } from \'../store\'', 'const open = 1', 'const count = signal(0)', '---', 'p {open} {count()}', ''].join('\n')
const SERVER = ['--- server', 'import { open } from \'./x\'', 'const open = 1', 'const row = ctx.url', 'export const x = row', 'export const look = recipe({ base: row })', '---', 'p {open}', ''].join('\n')

// A page setting moved into `page`, which walks the fence to ask whether the function reads itself and how often the rest reads its name.
const SETTING = ['--- server', 'import { open } from \'./x\'', 'const open = 1', 'export async function prerender() { return [] }', 'const count = signal(0)', '---', 'p {open} {count()}', ''].join('\n')
const CACHE = ['import * as server from \'kay/cache\'', 'import { open } from \'./store\'', 'const open = 1', 'export const stale = server.invalidatePage', ''].join('\n')

// The lines of the semantic tokens, as the editor reads their deltas.
function tokenLines(source: string): number[] {
  const data = semanticTokens(source)
  const lines: number[] = []
  let line = 0

  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!
    lines.push(line)
  }

  return lines
}

describe('a fence declaring a name twice', () => {
  it('compiles when it mentions a value of kay, as in a module path', () => {
    expect(() => compileKay(TWICE, 'src/routes/twice.kay')).not.toThrow()
  })

  it('compiles as a server fence exporting a name and reading one in a recipe', () => {
    expect(() => compileKay(SERVER, 'src/routes/server.kay')).not.toThrow()
  })

  it('takes the values of kay it reads unimported, and none named in a string', () => {
    const { implicit } = analyzeScript(TWICE, parseKay(TWICE).script)

    expect(implicit).toContain('signal')
    expect(implicit).not.toContain('store')
  })

  it('gives the fence no tokens, as Babel refuses it on every walk', () => {
    expect(tokenLines(TWICE).filter(line => line > 0 && line < 4)).toEqual([])
  })

  it('leaves no half-built scope behind the walks of a page setting', () => {
    const analysis = analyzeServer(SETTING, parseKay(SETTING).server)

    expect(walkScope(analysis!.fence!.ast, {})).toBe(false)
  })

  it('leaves no half-built scope behind a fence check, so the next walk refuses the fence too', () => {
    const fence = parseFence(CACHE, { start: 0, end: CACHE.length }, [])!

    serverOnlyImports(fence)

    expect(walkScope(fence.ast, {})).toBe(false)
  })
})

// A server fence exporting an action under the name of a value of kay, which the template passes on.
const EXPORTED = ['--- server', 'import { t } from \'elysia\'', 'import { action } from \'kay\'', '', 'export const local = action(t.Object({ name: t.String() }), ({ name }) => name)', '--- script', 'import Caller from \'../components/caller.kay\'', '---', 'Caller(run={local})', ''].join('\n')

describe('a name a server fence exports', () => {
  it('is the fence\'s own, not a value of kay the script imports beside it', () => {
    expect(() => compileKay(EXPORTED, 'src/routes/exported.kay')).not.toThrow()
  })
})
