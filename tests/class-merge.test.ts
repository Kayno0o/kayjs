import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { modeOf, resolveProject } from '../src/project'
import { installClassTable } from '../src/runtime/class-table'
import { servePages } from '../src/server/app'
import { fixtureCopy } from './scratch'

let root = ''
let client: Awaited<ReturnType<typeof buildClient>>

beforeAll(async () => {
  root = resolve(await fixtureCopy('class-merge'))
  client = await buildClient(root, { plugins: [tailwind] })
}, 120_000)

afterAll(async () => {
  installClassTable(undefined)
  await rm(root, { recursive: true, force: true })
})

describe('a class passed to a component', () => {
  it('writes the table into the manifest, with the classes that can meet another', () => {
    const classes = client.classTable?.classes ?? {}

    expect(Object.keys(classes)).toEqual(expect.arrayContaining(['p-4', 'p-6', 'text-sm', 'text-lg']))
    expect(classes.box).toBeUndefined()
    expect(classes['hover:p-2']).toBeUndefined()
  })

  it('overrides the class the component sets, on the server', async () => {
    const app = await servePages(resolveProject(root, { routes: 'src/routes', compress: false }, modeOf({ dev: false, prebuilt: true })), () => client)
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(html).toContain('class="box text-red-500 p-6 text-lg"')
    expect(html).toContain('class="box p-4 text-sm text-red-500 hover:p-2"')
    expect(html).toContain('class="box p-4 text-sm text-red-500"')
  })

  it('hands the table to the island entry', async () => {
    const files = await readdir(client.dir, { recursive: true })
    const texts = await Promise.all(files.filter(file => file.endsWith('.js')).map(async file => Bun.file(join(client.dir, file)).text()))

    expect(texts.some(text => text.includes('kay.classTable') && text.includes('"p-4"'))).toBe(true)
  })
})
