import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { LIVE_RELOAD } from '../src/server/dev'

interface ClientModule {
  mount: (element: HTMLElement) => () => void
}

let outdir: string
let client: ClientModule

// Lets queued effects land before the DOM is read.
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

// Bundles `main.kay` and the files beside it for the browser, and mounts it in a fresh element.
async function mountKay(files: Record<string, string>): Promise<{ root: HTMLElement, dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(import.meta.dir, '.dom-'))

  try {
    await Promise.all(Object.entries({ ...files, 'entry.ts': 'import { render } from \'kay/dom\'\nimport Main from \'./main.kay\'\n\nexport function mount(element: HTMLElement) {\n  return render(() => Main({}), element)\n}\n' }).map(async ([name, text]) => Bun.write(join(dir, name), text)))

    const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: join(dir, 'out'), target: 'browser', plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    const { mount } = await import(build.outputs[0]!.path) as Pick<ClientModule, 'mount'>
    const root = document.createElement('div')

    document.body.append(root)
    const unmount = mount(root)

    return { root, dispose: async () => {
      unmount()
      await rm(dir, { recursive: true, force: true })
    } }
  }
  catch (error) {
    await rm(dir, { recursive: true, force: true })

    throw error
  }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  outdir = await mkdtemp(join(tmpdir(), 'kay-dom-'))
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'fixtures/app/src/client.ts')],
    outdir,
    target: 'browser',
    plugins: [kay()],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  client = await import(build.outputs[0]!.path) as ClientModule
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

describe('client bundle', () => {
  it('renders and reacts to input through bind:value', async () => {
    const root = document.createElement('div')

    document.body.append(root)
    const dispose = client.mount(root)

    expect(root.querySelectorAll('li.todo')).toHaveLength(2)

    const input = root.querySelector<HTMLInputElement>('input[type=search]')!

    input.value = 'Ship'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect([...root.querySelectorAll('li.todo span')].map(span => span.textContent)).toEqual(['1. Ship it'])

    input.value = 'nothing'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.querySelector('li.empty')?.textContent).toBe('Nothing matches')
    dispose()
  })

  it('narrows an aliased if once its value appears', async () => {
    const root = document.createElement('div')

    document.body.append(root)
    const dispose = client.mount(root)

    expect(root.querySelector('p strong')).toBeNull()
    root.querySelector<HTMLInputElement>('li.todo input[type=checkbox]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(root.querySelector('p strong')?.textContent).toBe('Write the compiler')
    expect([...root.querySelectorAll('li.todo')].map(li => li.classList.contains('selected'))).toEqual([true, false])
    root.querySelectorAll<HTMLInputElement>('li.todo input[type=checkbox]')[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect([...root.querySelectorAll('li.todo')].map(li => li.classList.contains('selected'))).toEqual([false, true])
    dispose()
  })
})

describe('event handlers', () => {
  it('runs the handler a signal, a prop or a loop item holds when the event fires, not when it attached', async () => {
    const { root, dispose } = await mountKay({
      'button.kay': '---\nconst { onPress, label } = props<{ onPress?: () => void, label: string }>()\n---\nbutton(class={label} onClick={onPress}) {label}\n',
      'main.kay': '---\nimport { signal } from \'kay\'\nimport Button from \'./button.kay\'\n\nconst mode = signal(1)\nconst out = signal(\'\')\nconst rows = signal([{ id: 1, run: () => out.set(\'first\') }])\n---\nbutton.direct(onClick={mode() === 1 ? () => out.set(\'one\') : () => out.set(\'two\')}) Direct\nButton(label="prop" onPress={mode() === 1 ? undefined : () => out.set(\'prop\')})\nfor row of rows() key={row.id}\n  button.row(onClick={row.run}) Row\nbutton.switch(onClick={() => { mode.set(2); rows.set([{ id: 1, run: () => out.set(\'second\') }]) }}) Switch\np {out()}\n',
    })
    const click = async (selector: string) => {
      root.querySelector<HTMLElement>(selector)!.click()
      await settle()

      return root.querySelector('p')!.textContent
    }

    try {
      expect(await click('.direct')).toBe('one')
      expect(await click('.prop')).toBe('one')
      expect(await click('.row')).toBe('first')
      await click('.switch')
      expect(await click('.direct')).toBe('two')
      expect(await click('.prop')).toBe('prop')
      expect(await click('.row')).toBe('second')
    }
    finally {
      await dispose()
    }
  })
})

describe('loops', () => {
  it('keeps rendering components a loop iterates over as the list changes', async () => {
    const { root, dispose } = await mountKay({
      'a.kay': '---\nconst { v } = props<{ v: number }>()\n---\np.row A{v}\n',
      'b.kay': '---\nconst { v } = props<{ v: number }>()\n---\np.row B{v}\n',
      'main.kay': '---\nimport { signal } from \'kay\'\nimport A from \'./a.kay\'\nimport B from \'./b.kay\'\n\nconst list = signal([A])\n---\nbutton(onClick={() => list.set([B, A])}) Grow\nfor Row, i of list() key={Row}\n  Row(v={i})\n',
    })

    try {
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['A0'])
      root.querySelector('button')!.click()
      await settle()
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['B0', 'A1'])
    }
    finally {
      await dispose()
    }
  })

  it.each([
    ['as the only content of their element', 'ul\n  for n, i of list() key={n}\n    li {n}:{i}\n'],
    ['between other children, several nodes a row', 'ul\n  li.first first\n  for n, i of list() key={n}\n    li {n}:{i}\n    | ,\n  li.last last\n'],
  ])('move, insert and remove keyed rows %s, keeping the nodes of the rows that stay', async (_name, template) => {
    const { root, dispose } = await mountKay({
      'main.kay': `---\nimport { signal } from 'kay'\n\nconst list = signal([1, 2, 3, 4, 5, 6])\n;(globalThis as { setList?: (next: number[]) => void }).setList = next => list.set(next)\n---\n${template}`,
    })
    const setList = (globalThis as unknown as { setList: (next: number[]) => void }).setList
    const items = () => [...root.querySelectorAll('li:not(.first, .last)')]
    const keyOf = (item: Element) => item.textContent!.slice(0, item.textContent!.indexOf(':'))
    const byKey = new Map(items().map(item => [keyOf(item), item]))

    try {
      for (const next of [[1, 5, 3, 4, 2, 6], [1, 5, 4, 2, 6], [1, 5, 9, 4, 2, 6], [6, 2, 4, 9, 5, 1], [7, 6, 2, 4, 9, 5, 1, 8], [8, 1], [], [3, 1, 2]]) {
        setList(next)
        await settle()
        expect(items().map(item => item.textContent)).toEqual(next.map((n, i) => `${n}:${i}`))

        for (const item of items()) {
          const key = keyOf(item)

          expect(byKey.get(key) ?? item).toBe(item)
          byKey.set(key, item)
        }

        if (template.includes('first'))
          expect(root.querySelector('ul')!.textContent).toBe(`first${next.map((n, i) => `${n}:${i},`).join('')}last`)

        if (next.length === 0)
          byKey.clear()
      }
    }
    finally {
      await dispose()
    }
  })

  it('keep every node of multi-node rows through random reorders, inserts and removals', async () => {
    const { root, dispose } = await mountKay({
      'main.kay': '---\nimport { signal } from \'kay\'\n\nconst list = signal<number[]>([])\n;(globalThis as { setRows?: (next: number[]) => void }).setRows = next => list.set(next)\n---\np\n  b start\n  for n of list() key={n}\n    i {n}\n    | ;\n  b end\n',
    })
    const setRows = (globalThis as unknown as { setRows: (next: number[]) => void }).setRows
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647

    try {
      for (let round = 0; round < 300; round++) {
        const next = Array.from({ length: 12 }, (_, n) => n).filter(() => random() < 0.8).sort(() => random() - 0.5)

        setRows(next)
        await settle()
        expect(root.querySelector('p')!.textContent).toBe(`start${next.map(n => `${n};`).join('')}end`)
      }
    }
    finally {
      await dispose()
    }
  })
})

describe('blocks', () => {
  it('decode the entities of their text as the server markup does, and build an SVG child in the SVG namespace', async () => {
    const { root, dispose } = await mountKay({
      'main.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(1)\n---\nsvg(viewBox="0 0 2 2")\n  if n() > 0\n    circle(r="1")\np\n  if n() > 0\n    | Tom &amp; Jerry&nbsp;{n()}\n',
    })

    try {
      expect(root.querySelector('p')!.textContent).toBe('Tom & Jerry\u00A01')
      expect(root.querySelector('circle')!.namespaceURI).toBe('http://www.w3.org/2000/svg')
    }
    finally {
      await dispose()
    }
  })

  it('drop an await block whose branch went away before its value settled', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    let resolve: (value: string) => void = () => undefined
    const { root, dispose } = await mountKay({
      'main.kay': '---\nimport { signal } from \'kay\'\n\nconst shown = signal(true)\nconst value = new Promise<string>(done => (globalThis as { resolveValue?: (value: string) => void }).resolveValue = done)\n---\nbutton(onClick={() => shown.set(false)}) Hide\ndiv\n  if shown()\n    await value\n      p.wait Waiting\n    then text\n      p.text {text}\n',
    })

    resolve = (globalThis as unknown as { resolveValue: (value: string) => void }).resolveValue

    try {
      expect(root.querySelector('p.wait')).not.toBeNull()
      root.querySelector('button')!.click()
      await settle()
      resolve('late')
      await settle()
      expect(root.querySelector('div')!.textContent).toBe('')
      expect(errors).not.toHaveBeenCalled()
    }
    finally {
      errors.mockRestore()
      await dispose()
    }
  })
})

describe('slots with parameters', () => {
  it('render a row per item the component passes, following its list and the parent\'s signals', async () => {
    const { root, dispose } = await mountKay({
      'rows.kay': '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T) => JSX.Element }>()\n---\nul\n  for item of items key={item}\n    | {row(item)}\n',
      'main.kay': '---\nimport { signal } from \'kay\'\nimport Rows from \'./rows.kay\'\n\nconst names = signal([\'a\'])\nconst mark = signal(\'!\')\n---\nbutton(onClick={() => {\n  names.set([\'a\', \'b\'])\n  mark.set(\'?\')\n}}) Grow\nRows(items={names()})\n  @row(name)\n    li.row {name}{mark()}\n',
    })

    try {
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['a!'])
      root.querySelector('button')!.click()
      await settle()
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['a?', 'b?'])
    }
    finally {
      await dispose()
    }
  })
})

describe('bind:value on a number input', () => {
  it('keeps the signal\'s last number while the input is empty', async () => {
    const dir = await mkdtemp(join(import.meta.dir, '.dom-'))

    try {
      await Bun.write(join(dir, 'number.kay'), '---\nimport { signal } from \'kay\'\nconst n = signal<number>(5)\n---\ninput#num(type="number" bind:value={n})\ninput#range(type="range" min="0" max="10" bind:value={n})\np#out {n()}\n')
      await Bun.write(join(dir, 'entry.ts'), 'import { render } from \'kay/dom\'\nimport Number from \'./number.kay\'\n\nexport function mount(element: HTMLElement) {\n  return render(() => Number({}), element)\n}\n')

      const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: join(dir, 'out'), target: 'browser', plugins: [kay()] })

      if (!build.success)
        throw new AggregateError(build.logs, 'client build failed')

      const { mount } = await import(build.outputs[0]!.path) as Pick<ClientModule, 'mount'>
      const root = document.createElement('div')

      document.body.append(root)
      const dispose = mount(root)
      const input = root.querySelector<HTMLInputElement>('#num')!
      const output = root.querySelector('#out')!
      const type = async (value: string) => {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
      }

      expect(input.value).toBe('5')
      await type('7')
      expect(output.textContent).toBe('7')
      await type('')
      expect(output.textContent).toBe('7')
      await type('8.5')
      expect(output.textContent).toBe('8.5')
      dispose()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the live reload script', () => {
  it('swaps the stylesheets when the server comes back running the same code, and reloads on any other change or a page that fails', async () => {
    const script = (/<script>([\s\S]*)<\/script>/).exec(LIVE_RELOAD)![1]!
    const boot = (/let b="([^"]+)"/).exec(script)![1]!
    let onBoot: (event: { data: string }) => Promise<void> = async () => undefined
    const fetched: string[] = []
    let status = 200
    const reload = spyOn(location, 'reload').mockImplementation(() => undefined)
    const fetchStub = spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      fetched.push(url)

      return new Response('<html><head><link rel="stylesheet" href="/_kay/app-2.css"><link rel="stylesheet" href="/theme.css"></head><body></body></html>', { status })
    }) as unknown as typeof fetch)
    const stylesheets = () => [...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.getAttribute('href'))

    globalThis.EventSource = class {
      addEventListener(_name: string, listener: typeof onBoot) {
        onBoot = listener
      }
    } as unknown as typeof EventSource
    const { happyDOM } = globalThis as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean, handleDisabledFileLoadingAsSuccess: boolean }, setURL: (url: string) => void } }

    // A stylesheet link resolves against the page and fires `load` without fetching anything.
    happyDOM.setURL('http://localhost/page')
    Object.assign(happyDOM.settings, { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true })
    document.head.innerHTML = '<link rel="stylesheet" href="/_kay/app-1.css"><link rel="stylesheet" href="/theme.css">'

    try {
      // eslint-disable-next-line no-new-func -- runs the inline script a dev page carries
      new Function(script)()
      await onBoot({ data: `${boot} 3` })
      expect(fetched).toEqual([])

      await onBoot({ data: 'next 3' })
      expect(fetched).toEqual(['http://localhost/page'])
      expect(stylesheets()).toEqual(['/_kay/app-2.css', '/theme.css?kay-dev=next'])
      expect(reload).not.toHaveBeenCalled()

      status = 500
      await onBoot({ data: 'broken 3' })
      expect(reload).toHaveBeenCalledTimes(1)
      expect(stylesheets()).toEqual(['/_kay/app-2.css', '/theme.css?kay-dev=next'])

      await onBoot({ data: 'again 4' })
      expect(reload).toHaveBeenCalledTimes(2)
    }
    finally {
      reload.mockRestore()
      fetchStub.mockRestore()
      document.head.innerHTML = ''
      Object.assign(happyDOM.settings, { disableCSSFileLoading: false, handleDisabledFileLoadingAsSuccess: false })
    }
  })
})

describe('actions called from the browser', () => {
  it('read as pending while a call is in flight', async () => {
    let respond: (response: Response) => void = () => undefined
    const fetchStub = spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise<Response>((resolve) => {
      respond = resolve
    })) as unknown as typeof fetch)
    const { root, dispose } = await mountKay({
      'page.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String() }), ({ title }) => title)\n---\np Page\n',
      'main.kay': '---\nimport { add } from \'./page.kay\'\n---\nbutton(disabled={add.pending()} onClick={() => void add({ title: \'x\' })}) Add\n',
    })

    try {
      const button = root.querySelector('button')!

      await settle()
      expect(button.disabled).toBe(false)

      button.click()
      await settle()
      expect(button.disabled).toBe(true)

      respond(new Response('["x"]'))
      await settle()
      await settle()
      expect(button.disabled).toBe(false)
    }
    finally {
      fetchStub.mockRestore()
      await dispose()
    }
  })
})
