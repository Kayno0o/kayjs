import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { parseKay } from '../src/compiler/parser'
import { analyzeScript } from '../src/compiler/script'

// An edit passes through a fence declaring one name twice, which Babel's scope refuses; the fence still compiles, and its tsgo error is the one reported.
const TWICE = ['---', 'import { open } from \'../store\'', 'const open = 1', 'const count = signal(0)', '---', 'p {open} {count()}', ''].join('\n')

describe('a fence declaring a name twice', () => {
  it('compiles when it mentions a value of kay, as in a module path', () => {
    expect(() => compileKay(TWICE, 'src/routes/twice.kay')).not.toThrow()
  })

  it('still takes the values of kay it reads unimported', () => {
    expect(analyzeScript(TWICE, parseKay(TWICE).script).implicit).toContain('signal')
  })
})
