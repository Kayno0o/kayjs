import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
const PATTERNS = (await Bun.file(join(ROOT, 'package.json')).json() as { sideEffects: string[] }).sideEffects
const GLOBS = PATTERNS.map(pattern => new Bun.Glob(pattern.replace(/^\.\//, '')))
const declared = (file: string) => GLOBS.some(glob => glob.match(file))
const transpiler = new Bun.Transpiler({ loader: 'ts', define: { 'process.env.NODE_ENV': '"production"' } })
// What a statement outside a function does when its module runs, statements only: an effect inside an initializer is not seen: the kinds that make a module worth keeping when nothing it exports is used.
const EFFECTS = new Set(['ExpressionStatement', 'IfStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'TryStatement', 'SwitchStatement', 'ThrowStatement', 'BlockStatement', 'StaticBlock'])

// The tests, bench, examples, .kay and node_modules/.cache globs serve the repo's own apps and scratch projects, which inherit this package.json.
// A module outside the list is dropped from a bundle when nothing it exports is used, so one that registers a hook or listens to an event as it loads must be in `sideEffects` of package.json.
describe('the sideEffects of package.json', () => {
  it('names every file outside src/runtime, whose modules install hooks as they load, and the repo\'s own apps', async () => {
    const files = await Array.fromAsync(new Bun.Glob('src/**/*.{ts,kay}').scan(ROOT))
    const missing = files.filter(file => !file.startsWith('src/runtime/') && !declared(file))

    expect(missing).toEqual([])
    expect(declared('tests/fixtures/static/src/routes/index.kay')).toBe(true)
    expect(declared('bench/apps/kay/components/counter.kay')).toBe(true)
  })

  it('leaves out of the list only the modules of src/runtime with no top-level statement running as they load', async () => {
    const effects: string[] = []

    for (const file of await Array.fromAsync(new Bun.Glob('src/runtime/**/*.ts').scan(ROOT))) {
      if (file.endsWith('.d.ts') || declared(file))
        continue

      const program = parse(transpiler.transformSync(await Bun.file(join(ROOT, file)).text()), { sourceType: 'module' }).program

      for (const statement of program.body) {
        // A branch the production define turned off, which the bundler drops.
        if (statement.type === 'IfStatement' && statement.test.type === 'BooleanLiteral' && !statement.test.value)
          continue

        if (EFFECTS.has(statement.type))
          effects.push(`${relative('src/runtime', file)}:${statement.loc?.start.line ?? '?'} ${statement.type}`)
      }
    }

    expect(effects, 'a module of src/runtime running a statement as it loads goes in `sideEffects` of package.json, or the bundler drops it when nothing it exports is used').toEqual([])
  })
})
