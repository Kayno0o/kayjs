import { describe, expect, it } from 'bun:test'
import { serverOnlyReads } from '../src/build/server-only'

const names = (code: string) => serverOnlyReads(code).map(read => read.name)

describe('a server-only global in a built chunk', () => {
  it('is found as the bare read it is, whatever it is read for', () => {
    expect(names('var s = process.env.SITE_DOMAIN || void 0;\n')).toEqual(['process'])
    expect(names('Bun.file("x");\n')).toEqual(['Bun'])
    expect(names('var p = process; var s = p.env.X;\n')).toEqual(['process'])
    expect(names('process.on("exit", () => {});\nBun.serve({});\n')).toEqual(['Bun', 'process'])
  })

  it('is not the name of something else', () => {
    expect(names('function f(process) { return process.env.X }\n')).toEqual([])
    expect(names('var o = { process: 1 }; o.process; o["process"];\n')).toEqual([])
    expect(names('import process from "node:process";\nprocess.exit(0);\n')).toEqual([])
    expect(names('var Bun = globalThis.Bun; Bun?.file("x");\n')).toEqual([])
  })

  it('is left alone where a `typeof` asked about it first', () => {
    expect(names('var d = typeof process !== "undefined" && process.env.MODE;\n')).toEqual([])
    expect(names('var d = typeof process > "u" ? "x" : process.env.X;\n')).toEqual([])
    expect(names('if (typeof process !== "undefined") { process.env.X }\n')).toEqual([])
    expect(names('if (typeof process !== "undefined") process.env.X;\n')).toEqual([])
    expect(names('if (typeof process < "u") { var a = process.env.X; use(a) }\n')).toEqual([])
    expect(names('while (typeof process !== "undefined") { process.exit() }\n')).toEqual([])
    expect(names('function f() { if (typeof process === "undefined") return; return process.env.X }\n')).toEqual([])
    // The flag a module computes once and branches on later, minified into one declaration or not.
    expect(names('var has = typeof process !== "undefined";\nvar v = has ? process.env.X : 1;\n')).toEqual([])
    expect(names('var has = typeof process !== "undefined", v = has ? process.env.X : 1;\n')).toEqual([])
  })

  it('is found where the guard covers other code in the same statement, as minifying merges it', () => {
    expect(names('var o = typeof process < "u" ? "production" : "x", c = process.env.OTHER;\n')).toEqual(['process'])
    expect(names('var d = typeof Bun !== "undefined" && Bun.version, p = process.env.X;\n')).toEqual(['process'])
    // A guard on one global says nothing about another.
    expect(names('var d = typeof window !== "undefined" && process.env.X;\n')).toEqual(['process'])
  })

  it('is found outside the function a guard stands in', () => {
    expect(names('function f() { if (typeof process === "undefined") return; return process.env.X }\nvar top = process.env.Y;\n')).toEqual(['process'])
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
