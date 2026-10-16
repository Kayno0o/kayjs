import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { refuseServerOnlyReads, serverOnlyReads } from '../src/build/server-only'

const names = (code: string) => serverOnlyReads(code).map(read => read.name)

describe('a server-only global in a built chunk', () => {
  it.each([
    ['var s = process.env.SITE_DOMAIN || void 0;\n', ['process']],
    ['Bun.file("x");\n', ['Bun']],
    ['var p = process; var s = p.env.X;\n', ['process']],
    ['process.on("exit", () => {});\nBun.serve({});\n', ['Bun', 'process']],
  ])('is found as the bare read it is, whatever it is read for: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })

  it.each([
    ['function f(process) { return process.env.X }\n', []],
    ['var o = { process: 1 }; o.process; o["process"];\n', []],
    ['import process from "node:process";\nprocess.exit(0);\n', []],
    ['var Bun = globalThis.Bun; Bun?.file("x");\n', []],
  ])('is not the name of something else: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })

  it.each([
    ['var d = typeof process !== "undefined" && process.env.MODE;\n', []],
    ['var d = typeof process > "u" ? "x" : process.env.X;\n', []],
    ['if (typeof process !== "undefined") { process.env.X }\n', []],
    ['if (typeof process !== "undefined") process.env.X;\n', []],
    ['if (typeof process < "u") { var a = process.env.X; use(a) }\n', []],
    ['while (typeof process !== "undefined") { process.exit() }\n', []],
    ['function f() { if (typeof process === "undefined") return; return process.env.X }\n', []],
    // The flag a module computes once and branches on later, minified into one declaration or not.
    ['var has = typeof process !== "undefined";\nvar v = has ? process.env.X : 1;\n', []],
    ['var has = typeof process !== "undefined", v = has ? process.env.X : 1;\n', []],
  ])('is left alone where a `typeof` asked about it first: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })

  it.each([
    // html-to-image's getPixelRatio, as it ships.
    ['function ratio() { let p; try { p = process } catch (e) {} return p && p.env ? p.env.devicePixelRatio : null }\n', []],
    ['try { Bun.file("x") } catch {}\n', []],
    // A `finally` alone lets the error through, and the `catch` covers its `try` block, not itself.
    ['try { process.exit() } finally {}\n', ['process']],
    ['try { f() } catch (e) { process.exit() }\n', ['process']],
  ])('is left alone inside a `try` whose `catch` takes the error a missing global throws: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })

  it.each([
    ['var o = typeof process < "u" ? "production" : "x", c = process.env.OTHER;\n', ['process']],
    ['var d = typeof Bun !== "undefined" && Bun.version, p = process.env.X;\n', ['process']],
    // A guard on one global says nothing about another.
    ['var d = typeof window !== "undefined" && process.env.X;\n', ['process']],
  ])('is found where the guard covers other code in the same statement, as minifying merges it: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })

  it.each([
    ['function f() { if (typeof process === "undefined") return; return process.env.X }\nvar top = process.env.Y;\n', ['process']],
  ])('is found outside the function a guard stands in: %p', (code, found) => {
    expect(names(code)).toEqual(found)
  })
})

describe('the modules a chunk read it from', () => {
  it('names the ones whose own source reads it, a `.kay` fence included', () => {
    const modules = new Map([
      ['common/env.ts', 'export const s = process.env.SITE_DOMAIN || undefined\n'],
      ['src/counter.kay', '---\nconst own = process.env.OWN\n---\np {own}\n'],
      ['src/plain.kay', '---\nconst n = 1\n---\np {n}\n'],
      ['src/quiet.ts', 'export const x = 1\n'],
    ])

    expect(serverOnlyReads('var s = process.env.SITE_DOMAIN;\n', modules)).toEqual([{ name: 'process', modules: ['common/env.ts', 'src/counter.kay'] }])
  })

  it('leaves out a module that only reads what the build replaces with a literal', () => {
    const modules = new Map([['node_modules/dep/index.js', 'export const dev = process.env.NODE_ENV !== "production"\n'], ['src/own.ts', 'export const s = process.env.SITE_NAME\n']])

    expect(serverOnlyReads('var s = process.env.SITE_NAME;\n', modules)).toEqual([{ name: 'process', modules: ['src/own.ts'] }])
  })

  it('says so when no module of the chunk owns up to the read', () => {
    expect(serverOnlyReads('var s = process.env.X;\n', new Map([['src/a.ts', 'export const x = 1\n']]))).toEqual([{ name: 'process', modules: [] }])
  })
})

describe('the scans a build keeps', () => {
  it('reads a chunk scanned before off the cache, and scans one whose content changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-server-only-'))
    const dir = join(root, 'dist')
    const file = join(root, 'cache', 'server-only.json')
    const refuse = async () => refuseServerOnlyReads(root, dir, { 'chunk.js': {}, 'quiet.js': {} }, join(root, 'cache'))

    try {
      await Bun.write(join(dir, 'chunk.js'), 'var s = process.env.SITE;\n')
      await Bun.write(join(dir, 'quiet.js'), 'var s = 1;\n')
      await expect(refuse()).rejects.toThrow('`process` in chunk.js')

      const entry = await Bun.file(file).json() as { key: string, value: Record<string, string[] | null> }

      // Only the chunk worth parsing is kept, with what its scan found.
      expect(Object.values(entry.value)).toEqual([['process']])

      // A cache saying the chunk reads nothing is believed, which only a read off it would do.
      await Bun.write(file, JSON.stringify({ key: entry.key, value: Object.fromEntries(Object.keys(entry.value).map(hash => [hash, []])) }))
      await refuse()

      await Bun.write(join(dir, 'chunk.js'), 'var s = process.env.OTHER;\n')
      await expect(refuse()).rejects.toThrow('`process` in chunk.js')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
