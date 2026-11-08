import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { outputSchemasOf, WIRE_PRELUDE } from '../src/check/output-schema'
import { nativeExe } from '../src/compiler/native-typescript'
import { scratchDir } from './scratch'

// What `tsc --declaration` prints for each probe, as the build step reads it.
async function emit(probes: Record<string, string>, extra = ''): Promise<string> {
  const dir = await scratchDir('output-schema-')
  const lines = Object.entries(probes).map(([name, handler]) => `export const ${name} = probe(${handler})`)

  await Bun.write(join(dir, 'probe.ts'), `${WIRE_PRELUDE}\n${extra}\n${lines.join('\n')}\n`)
  await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, declaration: true, emitDeclarationOnly: true, outDir: 'out', target: 'esnext', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true }, files: ['probe.ts'] }))

  const child = Bun.spawn([nativeExe(), '-p', 'tsconfig.json'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

  await child.exited

  return Bun.file(join(dir, 'out', 'probe.d.ts')).text()
}

describe('the output schema read from a handler', () => {
  it('describes the JSON the answer is, from the type the checker prints', async () => {
    const declarations = await emit({
      user: 'async () => ({ id: 1, name: undefined as string | undefined, at: new Date(), big: 1n, tags: [] as string[], kind: \'a\' as \'a\' | \'b\', next: null as number | null, nested: [{ d: new Date() }], seen: new Set<number>(), by: new Map<string, boolean>(), any: {} as unknown, call: () => 1 })',
    })
    const user = outputSchemasOf(declarations).get('user')

    expect(user).toEqual({
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        at: { type: 'string' },
        big: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        kind: { enum: ['a', 'b'] },
        next: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        nested: { type: 'array', items: { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] } },
        seen: { type: 'array', items: { type: 'number' } },
        by: { type: 'object', additionalProperties: { type: 'boolean' } },
        any: {},
      },
      required: ['id', 'at', 'big', 'tags', 'kind', 'next', 'nested', 'seen', 'by', 'any'],
    })
  })

  it('lists none for an answer that is not an object or cannot be told', async () => {
    const declarations = await emit({
      text: '() => \'x\'',
      union: '() => 1 as number | { a: 1 }',
      list: '() => [{ a: 1 }]',
      nothing: '() => {}',
      anything: '(): any => 1',
      unknown: '(): unknown => 1',
      thrown: '(): never => { throw new Error() }',
    })
    const schemas = outputSchemasOf(declarations)

    expect([...schemas.keys()].sort()).toEqual(['anything', 'list', 'nothing', 'text', 'thrown', 'union', 'unknown'])
    expect([...schemas.values()].every(schema => schema === undefined)).toBe(true)
  })

  it('reads a recursive type as far as the checker prints it, then any value, and an empty object', async () => {
    const schemas = outputSchemasOf(await emit({ loose: '() => ({ tree: {} as Tree, ok: true })', empty: '() => ({})' }, 'interface Tree { children: Tree[] }'))

    expect(schemas.get('loose')).toEqual({ type: 'object', properties: { tree: { type: 'object', properties: { children: { type: 'array', items: {} } }, required: ['children'] }, ok: { type: 'boolean' } }, required: ['tree', 'ok'] })
    expect(schemas.get('empty')).toEqual({ type: 'object', properties: {} })
  })

  it('reads a readonly array, quoted keys and literals', () => {
    const schemas = outputSchemasOf('export declare const a: { \'b-c\': readonly string[]; n: -1 | 2; t: true; };')

    expect(schemas.get('a')).toEqual({ type: 'object', properties: { 'b-c': { type: 'array', items: { type: 'string' } }, 'n': { enum: [-1, 2] }, 't': { const: true } }, required: ['b-c', 'n', 't'] })
  })
})
