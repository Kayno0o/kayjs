import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from 'kay/bun'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

const COUNTER = `---
const { start, onGone } = props<{ start: number, onGone: () => void }>()
let count = signal(start)

onCleanup(onGone)
---
button(onClick={() => count++}) Clicked {count}
`

const ENTRY = `import { mount } from 'kay/mount'
import Counter from './counter.kay'

export function show(element: HTMLElement, onGone: () => void) {
  return mount(Counter, element, { start: 2, onGone })
}
`

const SCRIPT_SRC = /<script[^>]+src="([^"]+)"/
// Bun's own, before happy-dom puts its browser fetch in its place
const serverFetch = fetch

let dir: string

beforeAll(async () => {
  GlobalRegistrator.register()
  dir = await scratchDir('outside-page-')
  await Promise.all([Bun.write(join(dir, 'counter.kay'), COUNTER), Bun.write(join(dir, 'entry.ts'), ENTRY)])
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(dir, { recursive: true, force: true })
})

describe('a page kay does not serve', () => {
  it('bundles a component with kay/bun\'s plugin, which mount renders, keeps reacting and disposes', async () => {
    const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: join(dir, 'out'), target: 'browser', plugins: [kay({ root: dir })] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    const { show } = await import(build.outputs[0]!.path) as { show: (element: HTMLElement, onGone: () => void) => () => void }
    const element = document.createElement('div')
    let gone = 0

    document.body.append(element)
    const dispose = show(element, () => gone++)

    expect(element.textContent).toBe('Clicked 2')

    element.querySelector('button')!.click()
    await settle()

    expect(element.textContent).toBe('Clicked 3')

    dispose()

    expect(gone).toBe(1)
    expect(element.innerHTML).toBe('')
    element.remove()
  })

  it('builds a Bun.serve HTML import through bunfig\'s [serve.static] plugins', async () => {
    await Promise.all([
      Bun.write(join(dir, 'bunfig.toml'), '[serve.static]\nplugins = ["kay/bun"]\n'),
      Bun.write(join(dir, 'index.html'), '<!doctype html>\n<html><body><script type="module" src="./entry.ts"></script></body></html>\n'),
      Bun.write(join(dir, 'server.ts'), 'import page from \'./index.html\'\n\nconst server = Bun.serve({ port: 0, routes: { \'/\': page }, development: false })\n\nconsole.log(server.url.href)\n'),
    ])

    const server = Bun.spawn([process.execPath, 'server.ts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

    try {
      const reader = server.stdout.getReader()
      const { value } = await reader.read()
      const url = new TextDecoder().decode(value).trim()
      const page = await (await serverFetch(url)).text()
      const script = await serverFetch(new URL(page.match(SCRIPT_SRC)![1]!, url))

      expect(script.status).toBe(200)
      // Compiled into the bundle, where Bun alone ships an unknown file as its URL
      expect(await script.text()).toContain('<button>Clicked ')
    }
    finally {
      server.kill()
      await server.exited
    }
  })
})
