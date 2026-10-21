import type { ClassTable } from '../src/runtime/class-table'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { buildClassTable } from '../src/build/class-table'
import { buildClient } from '../src/build/client'
import { transformKayCached } from '../src/build/transform'
import { compileKay } from '../src/compiler'
import { devBuilder } from '../src/dev/builder'
import { modeOf, resolveProject } from '../src/project'
import { installClassTable } from '../src/runtime/class-table'
import { collectHead, head } from '../src/runtime/head'
import { classText } from '../src/runtime/values'
import { servePages } from '../src/server/app'
import { fixtureCopy, scratchDir } from './scratch'

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

async function islandChunks(): Promise<string> {
  const files = await readdir(client.dir, { recursive: true })

  return (await Promise.all(files.filter(file => file.endsWith('.js')).map(async file => Bun.file(join(client.dir, file)).text()))).join('\n')
}

describe('literal classes written together in one template', () => {
  it('resolve while compiling in the island, with no merge left to run there', async () => {
    const chunks = await islandChunks()

    expect(chunks).toContain('class="literal p-6"')
    expect(chunks).toContain('opened mt-4')
    expect(chunks).toContain('return "p-5"')
    expect(chunks).not.toContain('p-4 p-6')
    expect(chunks).not.toContain('mt-2 mt-4')
    expect(chunks).not.toContain('p-3 p-5')
  })

  it('resolve while rendering on the server, as the island does', async () => {
    const app = await servePages(resolveProject(root, { routes: 'src/routes', compress: false }, modeOf({ dev: false, prebuilt: true })), () => client)
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(html).toContain('class="literal p-6"')
    expect(html).toContain('class="box text-sm text-red-500 p-5"')
    expect(html).not.toContain('p-4 p-6')
  })

  it('compile with the table of the build, and again when it changes', async () => {
    const cacheDir = await scratchDir('class-merge-cache-')
    const source = '.p-4(class="p-6") x\n'
    const other = { sets: [[0], [1]], classes: { a: [0, 0], b: [0, 0] } } as ClassTable
    const compiled = async (classTable: ClassTable | undefined) => transformKayCached(source, join(root, 'src/components/cached.kay'), { target: 'dom', root, cacheDir, classTable })

    try {
      const withTable = await compiled(client.classTable)

      expect(withTable).toContain('class=\\"p-6\\"')
      expect(await compiled(other)).toContain('p-4 p-6')
      expect(await compiled(client.classTable)).toBe(withTable)
      expect(await compiled(undefined)).toContain('p-4 p-6')
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('stay as written, with no merge call, in an app without Tailwind', async () => {
    const plain = await scratchDir('class-merge-plain-')
    const source = '.p-4(class="p-6") x\nBox.p-4(class="p-6") y\n'

    try {
      await Bun.write(join(plain, 'src/app.css'), 'body { margin: 0 }\n')
      const server = await transformKayCached(source, join(plain, 'src/components/plain.kay'), { target: 'ssr', root: plain })
      const browser = compileKay(source, join(plain, 'src/components/plain.kay'), { root: plain, output: 'dom' }).tsx

      expect(server).not.toContain('KayClassName(')
      expect(server).not.toContain('KayComponentClass(')
      expect(server).toContain('p-4 p-6')
      expect(browser).not.toContain('KayComponentClass(')
      expect(browser).toContain('p-4 p-6')
    }
    finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('leave the island no merge call to run, and the server one only when the app has Tailwind', async () => {
    const source = '.p-4(class="p-6") x\nBox.p-4(class="p-6") y\n'
    const file = join(root, 'src/components/pairs.kay')
    const browser = compileKay(source, file, { root, output: 'dom', classTable: client.classTable }).tsx
    const server = await transformKayCached(source, file, { target: 'ssr', root })

    expect(browser).not.toContain('KayComponentClass(')
    expect(browser).not.toContain('KayClassName(')
    expect(server).toContain('KayClassName(["p-4","p-6"])')
    expect(server).toContain('KayComponentClass(["p-4", "p-6"])')
  })

  it('give a class written twice the one the server gives', () => {
    const { tsx } = compileKay('.card(class="card") x\n', join(root, 'src/components/twice.kay'), { root, output: 'dom', classTable: client.classTable })

    expect(tsx).toContain('class=\\"card\\"')
    expect(tsx).not.toContain('card card')
    expect(classText(['card', 'card'])).toBe('card')
  })

  it('merge in a dynamic merge the literals on their own side', () => {
    const { tsx } = compileKay('---\nconst rest = props<{ class?: string }>()\n---\n.p-4(class="p-6" {...rest}) x\n', join(root, 'src/components/spread.kay'), { root, output: 'dom', classTable: client.classTable })

    expect(tsx).toContain('["p-6", ')
    expect(tsx).not.toContain('"p-4"')
  })
})

describe('the class on <html>', () => {
  it('drops a layout\'s class that the page\'s overrides', () => {
    installClassTable(client.classTable)

    const { head: rendered } = collectHead(() => {
      head([{ tag: 'html', props: { class: 'p-4 dark' } }])
      head([{ tag: 'html', props: { class: 'p-6' } }])
    })

    expect(rendered.root).toContain('class="dark p-6"')
    installClassTable(undefined)
    expect(collectHead(() => {
      head([{ tag: 'html', props: { class: 'p-4 dark' } }])
      head([{ tag: 'html', props: { class: 'p-6' } }])
    }).head.root).toContain('class="p-4 dark p-6"')
  })
})

describe('kay dev with the class table', () => {
  async function stamps(dir: string): Promise<string> {
    const files = (await readdir(dir, { recursive: true })).filter(file => file.endsWith('.js')).toSorted()

    return (await Promise.all(files.map(async file => `${file}:${Bun.file(join(dir, file)).lastModified}`))).join(',')
  }

  it('builds the islands again when an edit changes the table, and not when it leaves it as it was', async () => {
    const project = resolve(await fixtureCopy('class-merge'))
    const page = join(project, 'src/routes/index.kay')
    const source = await Bun.file(page).text()
    const build = devBuilder(project, { plugins: [tailwind] })
    const edit = async (added: string) => {
      // A build reads its stylesheets' sources once done, which the next one waits for: an empty one, so the edit comes after.
      await build([])
      const before = await stamps(clientDir(project))

      await Bun.sleep(20)
      await Bun.write(page, `${source}p ${added}\n`)
      await build(['src/routes/index.kay'])

      return await stamps(clientDir(project)) !== before
    }

    try {
      expect((await build(null)).failed).toBe(false)
      expect(await edit('Bonjour tout le monde')).toBe(false)
      expect(await edit('py-2 py-4')).toBe(true)
      expect(await edit('py-2 py-4 Bonjour')).toBe(false)
      expect(await edit('py-2 py-4 py-8')).toBe(true)
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('Tailwind present but not loading', () => {
  it('says merging is off, once for a failure and again after a fix and a new failure', async () => {
    const project = await scratchDir('class-merge-broken-')
    const logs: string[] = []
    const spy = spyOn(console, 'warn').mockImplementation((message: string) => {
      logs.push(String(message))
    })

    try {
      await Bun.write(join(project, 'src/app.css'), '@import "tailwindcss";\n@import "./missing.css";\n')
      expect(await buildClassTable(project, ['p-4', 'p-6'])).toBeUndefined()
      expect(await buildClassTable(project, ['p-4', 'p-6'])).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('design system did not load')
      expect(logs[0]).toContain('later class does not override')

      await Bun.write(join(project, 'src/app.css'), '@import "tailwindcss";\n')
      expect(await buildClassTable(project, ['p-4', 'p-6'])).toBeDefined()
      await Bun.write(join(project, 'src/app.css'), '@import "tailwindcss";\n@import "./missing.css";\n')
      expect(await buildClassTable(project, ['p-4', 'p-6'])).toBeUndefined()
      expect(logs).toHaveLength(2)
    }
    finally {
      spy.mockRestore()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('stays quiet for an app without Tailwind', async () => {
    const project = await scratchDir('class-merge-plain-')
    const spy = spyOn(console, 'warn')

    try {
      await Bun.write(join(project, 'src/app.css'), 'body { margin: 0 }\n')
      expect(await buildClassTable(project, ['p-4', 'p-6'])).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
    }
    finally {
      spy.mockRestore()
      await rm(project, { recursive: true, force: true })
    }
  })
})
