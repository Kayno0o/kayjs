import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { scratchDir } from './scratch'

async function problems(source: string, lints?: object): Promise<string[]> {
  const dir = await scratchDir('untyped-socket-')

  await mkdir(join(dir, 'src', 'api'), { recursive: true })
  await writeFile(join(dir, 'src', 'api', 'chat.ts'), source)

  const { problems } = await writeShadowTypes(dir, { routes: 'src/routes', api: 'src/api', lints })

  return problems.filter(found => found.code === 'untyped-socket').map(found => found.message.match(/`([^`]+)`/)![1]!).sort()
}

const head = 'import { s } from \'kay\'\nimport { api, rooms } from \'kay/server\'\nconst chats = rooms<{ text: string }>()\n'

describe('the untyped-socket lint', () => {
  it('reports a ws route with a body and no response, whatever the way it is written', async () => {
    expect(await problems(`${head}export default api().ws('/a', { body: s.Object({ text: s.String() }), message() {} }).ws('/b', { 'body': s.String(), open() {} }).ws(\`/c\`, { body() {} })`)).toEqual(['/a', '/b', '/c'])
    expect(await problems(`import { api as server } from 'kay/server'\nconst app = server()\nexport default app.ws('/named', { body: {} as never })`)).toEqual(['/named'])
  })

  it('leaves a route with a response, one without a body, and what it cannot read', async () => {
    expect(await problems(`${head}export default api()
  .ws('/typed', { body: s.String(), response: chats.response })
  .ws('/schema', { body: s.String(), response: s.String() })
  .ws('/bare', { message() {} })
  .ws('/spread', { ...chats, body: s.String() })
  .ws('/held', held)
  .get('/other', () => 1, { body: s.String() })`)).toEqual([])
    expect(await problems(`import { api } from './my-api'\nexport default api().ws('/a', { body: 1 })`)).toEqual([])
  })

  it('follows the level set for it', async () => {
    const route = `${head}export default api().ws('/a', { body: s.String() })`

    expect(await problems(route, { 'untyped-socket': 'allow' })).toEqual([])
    expect(await problems(route, { 'untyped-socket': 'deny' })).toEqual(['/a'])
  })
})
