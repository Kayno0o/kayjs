import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { schemaJson } from '../src/check/schema-json'
import { scratchDir } from './scratch'

const WITH = '{ \'~standard\': { version: 1, vendor: \'mine\', validate: (value: unknown) => ({ value }), jsonSchema: { input: () => ({ type: \'object\' }) } } }'
const WITHOUT = '{ \'~standard\': { version: 1, vendor: \'mine\', validate: (value: unknown) => ({ value }) } }'

async function reported(files: Record<string, string>, lints?: Record<string, string>): Promise<string[]> {
  const root = await scratchDir('schema-json-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await schemaJson(root, lints ? { lints } : {})).map(diagnostic => `${diagnostic.file.slice(root.length + 1)}:${diagnostic.line}`).sort()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const action = (schema: string) => `import { action } from 'kay'\n\nconst input = ${schema}\n\nexport const add = action({ input }, ({ title }) => title)\n`
const route = (schema: string, key = 'body') => `import { api } from 'kay/server'\n\nconst schema = ${schema}\n\nexport default api().post('/x', () => 'ok', { ${key}: schema })\n`

describe('schema-without-json-schema', () => {
  it('reports an action input without jsonSchema in a .ts module and a .kay fence, and not one with it', async () => {
    expect(await reported({ 'src/a.ts': action(WITHOUT), 'src/b.ts': action(WITH) })).toEqual(['src/a.ts:5'])
    expect(await reported({ 'src/routes/index.kay': `--- server\n${action(WITHOUT)}---\np x\n` })).toEqual(['src/routes/index.kay:6'])
    expect(await reported({ 'src/routes/index.kay': `--- server\n${action(WITH)}---\np x\n` })).toEqual([])
  })

  it('reports each schema an API route takes, in a .ts module', async () => {
    for (const key of ['body', 'query', 'params', 'headers', 'cookie'])
      expect(await reported({ 'src/api.ts': route(WITHOUT, key) })).toEqual(['src/api.ts:5'])

    expect(await reported({ 'src/api.ts': route(WITH) })).toEqual([])
    expect(await reported({ 'src/api.ts': route(WITHOUT, 'detail') })).toEqual([])
  })

  it('reports valibot, bare or reached through a relative import, and not once it is wrapped', async () => {
    const valibot = 'import * as v from \'valibot\'\nexport const login = v.object({ title: v.string() })\n'
    const wrapped = 'import { toStandardJsonSchema } from \'@valibot/to-json-schema\'\nimport * as v from \'valibot\'\nexport const login = toStandardJsonSchema(v.object({ title: v.string() }))\n'
    const use = 'import { action } from \'kay\'\nimport { login } from \'./schemas\'\n\nexport const add = action({ input: login }, ({ title }) => title)\n'

    expect(await reported({ 'src/schemas.ts': valibot, 'src/a.ts': use })).toEqual(['src/a.ts:4'])
    expect(await reported({ 'src/schemas.ts': wrapped, 'src/a.ts': use })).toEqual([])
  })

  it('reports valibot and a hand-written validator reached through an import, in a .kay fence', async () => {
    const schemas = `export const login = ${WITHOUT}\n`
    const fence = '--- server\nimport { action } from \'kay\'\nimport { login } from \'../schemas\'\n\nexport const add = action({ input: login }, ({ title }) => title)\n---\np x\n'
    const valibot = '--- server\nimport { action } from \'kay\'\nimport * as v from \'valibot\'\n\nexport const add = action({ input: v.object({ title: v.string() }) }, ({ title }) => title)\n---\np x\n'

    expect(await reported({ 'src/schemas.ts': schemas, 'src/routes/index.kay': fence })).toEqual(['src/routes/index.kay:5'])
    expect(await reported({ 'src/routes/index.kay': valibot })).toEqual(['src/routes/index.kay:5'])
  })

  it('leaves kay\'s own schemas, a plain record, and a level of allow', async () => {
    expect(await reported({ 'src/a.ts': 'import { action, s } from \'kay\'\n\nexport const add = action({ input: { title: s.string() } }, ({ title }) => title)\nexport const two = action({ input: s.object({ title: s.string() }) }, ({ title }) => title)\n' })).toEqual([])
    expect(await reported({ 'src/a.ts': action(WITHOUT) }, { 'schema-without-json-schema': 'allow' })).toEqual([])
  })
})
