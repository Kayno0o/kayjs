import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay, formatDiagnostic } from '../src/compiler'
import { formatKay } from '../src/format'

const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
const spec = await Bun.file(join(import.meta.dir, '..', 'llms.txt')).text()
const examples = [...spec.matchAll(KAY_BLOCK)].map(match => match[1]!)

// The spec's examples are what an LLM copies, so each one has to compile and already be formatted.
describe('llms.txt', () => {
  it('has examples', () => {
    expect(examples.length).toBeGreaterThan(5)
  })

  it.each(examples.map((source, index) => [index, source]))('example %d compiles cleanly and is formatted', (_index, source) => {
    const filename = source.startsWith('--- server') ? 'src/routes/example.kay' : 'src/example.kay'
    const { diagnostics } = compileKay(source, filename)

    expect(diagnostics.map(diagnostic => formatDiagnostic(source, filename, diagnostic))).toEqual([])
    expect(formatKay(source).code).toBe(source)
  })

  it('names an entry point the package exports', async () => {
    expect(await import('kay/server')).toHaveProperty('pages')
    expect(await import('kay/server')).toMatchObject({ clientAddress: expect.any(Function), rateKey: expect.any(Function) })
  })

  it('keeps what generated code and kay\'s own build import off the public entries', async () => {
    const runtime = await import('kay')
    const server = await import('kay/server')

    expect(Object.keys(await import('kay/compiler')).sort()).toEqual(['compileKay', 'formatDiagnostic'])
    expect(Object.keys(await import('kay/image'))).toEqual(['image'])
    expect(Object.keys(await import('kay/internal')).sort()).toEqual(['actionStub', 'formAction', 'isAction', 'registerActions', 'registerImage'])
    expect(Object.keys(await import('kay/internal/server'))).toEqual(['registerBundle'])
    expect(['actionStub', 'formAction', 'isAction', 'registerActions'].filter(name => name in runtime)).toEqual([])
    expect(['registerBundle', 'shutDown', 'events'].filter(name => name in server)).toEqual([])
    expect(server).toMatchObject({ shutdown: expect.any(Function), eventStream: expect.any(Function) })
    expect(Object.keys(await import('kay/i18n')).filter(name => name === 'runInLocale' || name === 'localeState')).toEqual([])
  })
})
