import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { patch } from '../src/runtime/dev-patch'
import { cappedSizes } from '../src/runtime/image'
import { LIVE_RELOAD } from '../src/server/dev'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

interface ClientModule {
  mount: (element: HTMLElement) => () => void
}

let client: ClientModule
const dirs: string[] = []

interface Site {
  files: Record<string, string | Blob>
  alone: boolean
  main?: (props: object) => unknown
  render?: (fn: () => unknown, element: Element) => () => void
}

// Each case is a `main.kay` and the files beside it, declared while the file loads so beforeAll bundles all of them in one build. A case reading what the page holds when its bundle loads (a meta tag) is `alone`, bundled when it mounts.
const sites: Site[] = []

// Declares a case, and hands back what mounts it in a fresh element.
function site(files: Site['files'], alone = false): () => Promise<{ root: HTMLElement, dispose: () => Promise<void> }> {
  const declared: Site = { files, alone }

  sites.push(declared)

  return async () => {
    // Bundled when mounted, so the page holds what it reads as the bundle loads.
    if (alone)
      await bundle([declared])

    const root = document.createElement('div')

    document.body.append(root)

    const unmount = declared.render!(() => declared.main!({}), root)

    return { root, dispose: async () => unmount() }
  }
}

// Bundles the cases for the browser, which `mains` they export in order.
async function bundle(group: Site[], entrypoints: string[] = []): Promise<string[]> {
  const folder = await scratchDir('dom-')

  await Bun.write(join(folder, 'entry.ts'), `import { render } from 'kay/dom'\n${group.map((_, index) => `import Main${index} from './${index}/main.kay'`).join('\n')}\n\nexport const mains = [${group.map((_, index) => `Main${index}`).join(', ')}]\nexport { render }\n`)
  await Promise.all(group.flatMap((declared, index) => Object.entries(declared.files).map(async ([name, text]) => Bun.write(join(folder, String(index), name), text))))

  const build = await Bun.build({ entrypoints: [...entrypoints, join(folder, 'entry.ts')], outdir: join(folder, 'out'), target: 'browser', plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  const [cases, ...others] = build.outputs.filter(output => output.kind === 'entry-point').reverse()
  const module = await import(cases!.path) as { mains: NonNullable<Site['main']>[], render: NonNullable<Site['render']> }

  for (const [index, declared] of group.entries()) {
    declared.main = module.mains[index]!
    declared.render = module.render
  }

  dirs.push(folder)

  return others.reverse().map(output => output.path)
}

beforeAll(async () => {
  GlobalRegistrator.register()

  const [app] = await bundle(sites.filter(declared => !declared.alone), [join(import.meta.dir, 'fixtures/app/src/client.ts')])

  client = await import(app!) as ClientModule
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await Promise.all(dirs.map(async folder => rm(folder, { recursive: true, force: true })))
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

describe('a dynamic tag', () => {
  it('refuses a tag that is no element name, and takes from its props what a spread may set', async () => {
    const { dynamic } = await import('../src/runtime/dom')
    const frame = dynamic('iframe', { srcdoc: '<script>alert(1)</script>', onclick: 'alert(1)', title: 'a' }) as Element

    expect(frame.outerHTML).toBe('<iframe title="a"></iframe>')
    expect(() => dynamic('img src=x onerror=alert(1)', {})).toThrow('is not an element name')
  })

  it('loads the submit hold only when its props may carry an onSubmit, written or spread', () => {
    const compiled = (tag: string) => compileKay(`---\nconst { as: Tag = 'form' } = props<{ as?: string }>()\n---\n${tag}\n`, 'main.kay', { output: 'dom' }).tsx

    expect(compiled('Tag(onSubmit={() => undefined})')).toContain('KayHoldSubmits()')
    expect(compiled('Tag({...{}})')).toContain('KayHoldSubmits()')
    expect(compiled('Tag(class="a" onClick={() => undefined})')).not.toContain('KayHoldSubmits()')
  })
})

describe('a spread onto an element in the browser', () => {
  const mount1 = site({
    'main.kay': '---\nimport { sanitizeHtml, trustHtml } from \'kay\'\n\nconst raw = \'<i>raw-dom-1</i>\'\nconst marked = trustHtml(\'<b>marked-dom-1</b>\')\nconst loaded = JSON.parse(JSON.stringify({ innerHTML: marked }))\n---\ndiv.trusted({...{ innerHTML: marked }})\ndiv.sanitized({...{ innerHTML: sanitizeHtml(\'<u>s</u><script>x</script>\') }})\ndiv.raw({...{ innerHTML: raw }})\ndiv.derived({...{ innerHTML: `${marked}<img src=x>` }})\nsvg.drawn({...{ innerHTML: trustHtml(\'<path d="M0 0"/>\') }})\nsvg.rawsvg({...{ innerHTML: \'<path d="raw"/>\' }})\nmath.rawmath({...{ innerHTML: \'<mi>raw</mi>\' }})\ndiv.json({...loaded})\n',
  })

  it('takes innerHTML only as markup something vouched for, and leaves the element empty otherwise', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const { root, dispose } = await mount1()

    try {
      expect(root.querySelector('.trusted')!.innerHTML).toBe('<b>marked-dom-1</b>')
      expect(root.querySelector('.sanitized')!.innerHTML).toBe('<u>s</u>')
      expect(root.querySelector('.drawn')!.innerHTML).toBe('<path d="M0 0"></path>')
      expect([...root.querySelectorAll('.raw, .derived, .rawsvg, .rawmath')].map(element => element.innerHTML)).toEqual(['', '', '', ''])
      // Vouched in this page, so the same markup survives a JSON round trip by value.
      expect(root.querySelector('.json')!.innerHTML).toBe('<b>marked-dom-1</b>')
    }
    finally {
      warn.mockRestore()
      await dispose()
    }
  })
})

describe('a spread onto an element in the browser, as it changes', () => {
  const mount2 = site({
    'main.kay': '---\nimport { persisted, signal, trustHtml } from \'kay\'\n\nconst safe = trustHtml(\'<b>live-dom-1</b>\')\nconst turn = signal(0)\nconst stored = persisted(\'forged\', \'\')\n---\ndiv.live({...{ get innerHTML() { return turn() === 0 ? safe : \'<i>live-raw-1</i>\' } }})\nbutton(onClick={() => turn.set(1)}) turn\ndiv.cookie({...{ innerHTML: stored() }})\n',
  })

  it('checks a getter on each read, warns when it turns raw, and reads a forged cookie as nothing vouched for', async () => {
    const forged = '[["SafeHtml",1],"!<img src=x onerror=alert(1)>"]'

    document.cookie = `forged=${encodeURIComponent(forged)}`

    const { root, dispose } = await mount2()
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(root.querySelector('.live')!.innerHTML).toBe('<b>live-dom-1</b>')
      expect(root.querySelector('.cookie')!.innerHTML).toBe('')
      expect(warn).not.toHaveBeenCalled()
      root.querySelector('button')!.click()
      await settle()
      expect(root.querySelector('.live')!.innerHTML).toBe('')
      expect(String(warn.mock.calls[0]![0])).toContain('nothing vouched for')
    }
    finally {
      warn.mockRestore()
      document.cookie = 'forged=; max-age=0'
      await dispose()
    }
  })
})

describe('component class', () => {
  const mount3 = site({
    'tagged.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\np(title={`[${className}]`})\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport Tagged from \'./tagged.kay\'\n\nconst on = signal(false)\nconst sp = { class: \'FROM\' }\n---\nTagged.a({...sp} class={{ on: on() }})\nbutton(onClick={() => on.set(o => !o)}) x\n',
  })

  it('hands a component the merged class as one string, following what it merges', async () => {
    const { root, dispose } = await mount3()

    try {
      expect(root.querySelector('p')!.title).toBe('[a FROM]')
      root.querySelector('button')!.click()
      await settle()
      expect(root.querySelector('p')!.title).toBe('[a FROM on]')
    }
    finally {
      await dispose()
    }
  })
})

describe('ARIA states', () => {
  const mount4 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst open = signal<boolean | null>(false)\n---\nbutton(aria-expanded={open()} hidden={open() === true} onClick={() => open.set(open() === false ? true : null)}) x\ndiv({...{ \'aria-busy\': open() }})\n',
  })

  it('render a boolean as "true" or "false" as it changes, set or spread, null leaving the attribute out', async () => {
    const { root, dispose } = await mount4()

    try {
      const button = root.querySelector('button')!
      const div = root.querySelector('div')!

      expect([button.getAttribute('aria-expanded'), div.getAttribute('aria-busy'), button.hasAttribute('hidden')]).toEqual(['false', 'false', false])
      button.click()
      await settle()
      expect([button.getAttribute('aria-expanded'), div.getAttribute('aria-busy'), button.getAttribute('hidden')]).toEqual(['true', 'true', ''])
      button.click()
      await settle()
      expect([button.hasAttribute('aria-expanded'), div.hasAttribute('aria-busy'), button.hasAttribute('hidden')]).toEqual([false, false, false])
    }
    finally {
      await dispose()
    }
  })
})

describe('bound URLs', () => {
  const mount5 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst url = signal(\'/home\')\n---\na(href={url()}) x\nimg(alt="" {...{ src: url() }})\nbutton(onClick={() => url.set(\' javascript:alert(1)\')}) x\n',
  })

  it('neutralise one that would run script, set or spread, as it changes', async () => {
    const { root, dispose } = await mount5()

    try {
      expect(root.querySelector('a')!.getAttribute('href')).toBe('/home')
      root.querySelector('button')!.click()
      await settle()
      expect(root.querySelector('a')!.getAttribute('href')).toBe('unsafe: javascript:alert(1)')
      expect(root.querySelector('img')!.getAttribute('src')).toBe('unsafe: javascript:alert(1)')
    }
    finally {
      await dispose()
    }
  })
})

describe('imported images', () => {
  const mount6 = site({
    'main.kay': '---\nimport hero from \'./hero.png\'\n---\nimg(src={hero} alt="")\n',
    'hero.png': Bun.file(join(import.meta.dir, 'fixtures/images/src/hero.png')),
  }, true)

  it('cap their density as images.maxDensity, which the server wrote on the page, sets it', async () => {
    const meta = Object.assign(document.createElement('meta'), { name: 'kay-max-density', content: '1' })

    document.head.append(meta)

    const { root, dispose } = await mount6()

    try {
      expect(root.querySelector('img')!.getAttribute('sizes')).toBe(cappedSizes('100vw', 1))
    }
    finally {
      meta.remove()
      await dispose()
    }
  })

  const mount8 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\nimport hero from \'./hero.png\'\n\nconst src = signal(hero)\n---\nimg.hero(src={src()} sizes="50vw" alt="")\nimg.sized(src={hero} height="10" alt="")\nbutton(onClick={() => src.set(\'/logo.svg\')}) x\n',
    'hero.png': Bun.file(join(import.meta.dir, 'fixtures/images/src/hero.png')),
  })

  it('load the size they show at in an island too, and a source that changes clears what the last one set', async () => {
    const { root, dispose } = await mount8()

    try {
      const hero = root.querySelector('img.hero')!
      const sized = root.querySelector('img.sized')!

      expect(hero.getAttribute('srcset')).toEndWith(' 1000w')
      expect([hero.getAttribute('width'), hero.getAttribute('height')]).toEqual(['1000', '600'])
      expect(hero.getAttribute('src')).toEndWith('&w=1000')
      expect(hero.getAttribute('sizes')).toBe(cappedSizes('50vw', 2))
      expect([sized.getAttribute('width'), sized.getAttribute('height'), sized.hasAttribute('srcset')]).toEqual([null, '10', true])

      root.querySelector('button')!.click()
      await settle()

      expect([hero.getAttribute('src'), hero.getAttribute('srcset'), hero.getAttribute('sizes'), hero.getAttribute('width')]).toEqual(['/logo.svg', null, '50vw', null])
    }
    finally {
      await dispose()
    }
  })
})

describe('event handlers', () => {
  const mount9 = site({
    'button.kay': '---\nconst { onPress, label } = props<{ onPress?: () => void, label: string }>()\n---\nbutton(class={label} onClick={onPress}) {label}\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport Button from \'./button.kay\'\n\nconst mode = signal(1)\nconst out = signal(\'\')\nconst rows = signal([{ id: 1, run: () => out.set(\'first\') }])\n---\nbutton.direct(onClick={mode() === 1 ? () => out.set(\'one\') : () => out.set(\'two\')}) Direct\nButton(label="prop" onPress={mode() === 1 ? undefined : () => out.set(\'prop\')})\nfor row of rows() key={row.id}\n  button.row(onClick={row.run}) Row\nbutton.switch(onClick={() => { mode.set(2); rows.set([{ id: 1, run: () => out.set(\'second\') }]) }}) Switch\np {out()}\n',
  })

  it('runs the handler a signal, a prop or a loop item holds when the event fires, not when it attached', async () => {
    const { root, dispose } = await mount9()
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

describe('kay without imports', () => {
  const mount10 = site({
    'main.kay': '---\nconst count = signal(1)\nconst double = memo(() => count() * 2)\nconst seen = signal(0)\nconst mounted = signal(false)\n\neffect(() => seen.set(count()))\nonMount(() => mounted.set(true))\nonCleanup(() => { document.body.dataset.cleaned = \'yes\' })\n---\nbutton(onClick={() => count.set(c => c + 1)}) {double()} {seen()} {mounted() ? \'mounted\' : \'not yet\'}\n',
  })

  it('runs signal, memo, effect, onMount and onCleanup a script uses unimported', async () => {
    const { root, dispose } = await mount10()

    try {
      await settle()
      expect(root.querySelector('button')!.textContent).toBe('2 1 mounted')
      root.querySelector('button')!.click()
      await settle()
      expect(root.querySelector('button')!.textContent).toBe('4 2 mounted')
      expect(document.body.dataset.cleaned).toBeUndefined()
    }
    finally {
      await dispose()
    }
    expect(document.body.dataset.cleaned).toBe('yes')
    delete document.body.dataset.cleaned
  })
})

describe('signals in the template', () => {
  const mount11 = site({
    'main.kay': '---\nconst items = signal([\'a\'])\nconst count = memo(() => items().length)\nconst draft = signal(\'b\')\n---\ninput(bind:value={draft})\nbutton(onClick={() => items.set([...items(), draft()])}) {count()} items\nif count() > 1\n  p.many many\nul\n  for item of items()\n    li {item}\n',
  })

  it('read by calling them, in text, conditions, loops and handlers, a bind still writing the signal', async () => {
    const { root, dispose } = await mount11()
    const texts = () => [...root.querySelectorAll('li')].map(item => item.textContent)

    try {
      expect(root.querySelector('button')!.textContent).toBe('1 items')
      expect(root.querySelector('.many')).toBeNull()

      const input = root.querySelector('input')!

      input.value = 'c'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      root.querySelector('button')!.click()
      await settle()

      expect(root.querySelector('button')!.textContent).toBe('2 items')
      expect(root.querySelector('.many')).not.toBeNull()
      expect(texts()).toEqual(['a', 'c'])
    }
    finally {
      await dispose()
    }
  })
})

describe('signal writes', () => {
  const unseen = site({
    'theme.ts': 'import { signal } from \'kay\'\n\nconst accent = signal(\'red\')\n\nexport { accent }\nexport function makeCounter() {\n  return signal(0)\n}\nexport function useDialog() {\n  return { open: signal(false) }\n}\n',
    'colors.ts': 'export { accent } from \'./theme\'\n',
    'size.ts': 'import { signal } from \'kay\'\n\nexport default signal<number | undefined>()\n',
    'main.kay': '---\nimport { accent } from \'./colors\'\nimport { makeCounter, useDialog } from \'./theme\'\nimport size from \'./size\'\n\nconst counter = makeCounter()\nconst { open } = useDialog()\n\nfunction reset() {\n  counter = 0\n}\n---\nbutton.more(onClick={() => counter += 2}) {counter()}\nbutton.reset(onClick={reset}) reset\nbutton.one(onClick={() => counter++}) one\nbutton.size(onClick={() => size ??= 3}) {size() ?? \'none\'}\nbutton.accent(onClick={() => accent = \'blue\'}) {accent()}\nbutton.open(onClick={() => open = !open()}) {open() ? \'open\' : \'closed\'}\n',
  })

  it('assigns a signal kay cannot see made: a re-export, a default export, one a function returns and one destructured off what it returns', async () => {
    const { root, dispose } = await unseen()
    const text = (selector: string) => root.querySelector(selector)!.textContent
    const click = async (selector: string) => {
      root.querySelector<HTMLElement>(selector)!.click()
      await settle()
    }

    try {
      await click('.more')
      await click('.more')
      expect(text('.more')).toBe('4')
      await click('.reset')
      expect(text('.more')).toBe('0')
      await click('.one')
      expect(text('.more')).toBe('1')
      expect(text('.size')).toBe('none')
      await click('.size')
      expect(text('.size')).toBe('3')
      await click('.accent')
      expect(text('.accent')).toBe('blue')
      await click('.open')
      expect(text('.open')).toBe('open')
    }
    finally {
      await dispose()
    }
  })

  const mount12 = site({
    'theme.ts': 'import { memo, signal } from \'kay\'\n\nexport const accent = signal(\'red\')\nexport const loud = memo(() => accent().toUpperCase())\n',
    'toggle.kay': '---\nimport type { Signal } from \'kay\'\n\nconst { open } = props<{ open: Signal<boolean> }>()\n---\nbutton.toggle(onClick={() => open = !open()}) {open() ? \'open\' : \'closed\'}\n',
    'main.kay': '---\nimport { accent, loud } from \'./theme\'\nimport Toggle from \'./toggle.kay\'\n\nconst count = signal(0)\nconst open = signal(false)\n\nfunction reset() {\n  count = 0\n}\n---\nbutton.more(onClick={() => count++}) {count()}\nbutton.ten(onClick={() => count += 10}) ten\nbutton.reset(onClick={reset}) reset\nbutton.accent(onClick={() => accent = accent() === \'red\' ? \'blue\' : \'red\'}) {accent()} {loud()}\nToggle(open={open})\np.state {open() ? \'yes\' : \'no\'}\n',
  })

  it('assigns a signal by name, its own, a module\'s and one a prop holds, reads them all by calling them, and hands a component the signal itself', async () => {
    const { root, dispose } = await mount12()
    const text = (selector: string) => root.querySelector(selector)!.textContent
    const click = async (selector: string) => {
      root.querySelector<HTMLElement>(selector)!.click()
      await settle()
    }

    try {
      await click('.more')
      await click('.more')
      await click('.ten')
      expect(text('.more')).toBe('12')
      await click('.reset')
      expect(text('.more')).toBe('0')
      await click('.accent')
      expect(text('.accent')).toBe('blue BLUE')
      expect([text('.toggle'), text('.state')]).toEqual(['closed', 'no'])
      await click('.toggle')
      expect([text('.toggle'), text('.state')]).toEqual(['open', 'yes'])
    }
    finally {
      await dispose()
    }
  })
})

describe('loops', () => {
  const mount13 = site({
    'a.kay': '---\nconst { v } = props<{ v: number }>()\n---\np.row A{v}\n',
    'b.kay': '---\nconst { v } = props<{ v: number }>()\n---\np.row B{v}\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport A from \'./a.kay\'\nimport B from \'./b.kay\'\n\nconst list = signal([A])\n---\nbutton(onClick={() => list.set([B, A])}) Grow\nfor Row, i of list() key={Row}\n  Row(v={i})\n',
  })

  it('keeps rendering components a loop iterates over as the list changes', async () => {
    const { root, dispose } = await mount13()

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

  const keyed = ([
    ['as the only content of their element', 'ul\n  for n, i of list() key={n}\n    li {n}:{i}\n'],
    ['between other children, several nodes a row', 'ul\n  li.first first\n  for n, i of list() key={n}\n    li {n}:{i}\n    | ,\n  li.last last\n'],
    ['with no key, matched by the value itself', 'ul\n  for n, i of list()\n    li {n}:{i}\n'],
  ] as const).map(([name, template]) => [name, template, site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst list = signal([1, 2, 3, 4, 5, 6])\n;(globalThis as { setList?: (next: number[]) => void }).setList = next => list.set(next)\n---\n${template}`,
  })] as const)

  it.each(keyed)('move, insert and remove keyed rows %s, keeping the nodes of the rows that stay', async (_name, template, mount) => {
    const { root, dispose } = await mount()
    const setList = (globalThis as unknown as { setList: (next: number[]) => void }).setList
    const items = () => [...root.querySelectorAll('li:not(.first, .last)')]
    const keyOf = (item: Element) => item.textContent.slice(0, item.textContent.indexOf(':'))
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

  const mount14 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst list = signal([{ id: 1, name: \'a\' }, { id: 2, name: \'b\' }])\n;(globalThis as { setItems?: (next: { id: number, name: string }[]) => void }).setItems = next => list.set(next)\n---\nul\n  for item of list()\n    li {item.name}\n',
  })

  it('match rows with no key by their item\'s id, so fresh copies of the same items keep their nodes', async () => {
    const { root, dispose } = await mount14()
    const setItems = (globalThis as unknown as { setItems: (next: { id: number, name: string }[]) => void }).setItems
    const [a, b] = root.querySelectorAll('li')

    try {
      setItems([{ id: 2, name: 'B' }, { id: 1, name: 'A' }, { id: 3, name: 'c' }])
      await settle()

      const items = [...root.querySelectorAll('li')]

      expect(items.map(item => item.textContent)).toEqual(['B', 'A', 'c'])
      expect(items[0]).toBe(b)
      expect(items[1]).toBe(a)
    }
    finally {
      await dispose()
    }
  })

  const mount15 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst list = signal([{ id: 1, label: \'a\' }, { id: 2, label: \'b\' }])\nlet drawn = 0\nconst draw = (id: number) => `#${id}:${++drawn}`\n;(globalThis as { relabel?: () => void }).relabel = () => list.set(list().map(item => ({ ...item, label: `${item.label}!` })))\n---\nul\n  for item of list() key={item.id}\n    li\n      b {item.label}\n      i {draw(item.id)}\n',
  })

  it('leave what reads only a row\'s key alone when its item is replaced by a copy under the same key', async () => {
    const { root, dispose } = await mount15()
    const relabel = (globalThis as unknown as { relabel: () => void }).relabel

    try {
      relabel()
      await settle()

      expect([...root.querySelectorAll('li')].map(item => item.textContent)).toEqual(['a!#1:1', 'b!#2:2'])
    }
    finally {
      await dispose()
    }
  })

  const mount16 = site({
    'rows.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: { id: number, label: string }[], row: (label: string) => JSX.Element }>()\n---\nfor item of items key={item.id}\n  | {row(item.label)}\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport Rows from \'./rows.kay\'\n\nconst list = signal([{ id: 1, label: \'a\' }])\n;(globalThis as { relabel?: () => void }).relabel = () => list.set([{ id: 1, label: \'b\' }])\n---\nRows(items={list()})\n  @row(label)\n    input(name={label})\n',
  })

  it('warn when a part drawn again replaces the focused element with a new one of its kind', async () => {
    const { root, dispose } = await mount16()
    const relabel = (globalThis as unknown as { relabel: () => void }).relabel
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      root.querySelector('input')!.focus()
      relabel()
      await settle()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]).toEqual([expect.stringContaining('drew a new <input> in place of the focused one'), root.querySelector('input[name="b"]')])
    }
    finally {
      warn.mockRestore()
      await dispose()
    }
  })

  const mount17 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst list = signal<number[]>([])\n;(globalThis as { setRows?: (next: number[]) => void }).setRows = next => list.set(next)\n---\np\n  b start\n  for n of list() key={n}\n    i {n}\n    | ;\n  b end\n',
  })

  it('keep every node of multi-node rows through random reorders, inserts and removals', async () => {
    const { root, dispose } = await mount17()
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
  const mount18 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(1)\n---\nsvg(viewBox="0 0 2 2")\n  if n() > 0\n    circle(r="1")\np\n  if n() > 0\n    | Tom &amp; Jerry&nbsp;{n()}\n',
  })

  it('decode the entities of their text as the server markup does, and build an SVG child in the SVG namespace', async () => {
    const { root, dispose } = await mount18()

    try {
      expect(root.querySelector('p')!.textContent).toBe('Tom & Jerry\u00A01')
      expect(root.querySelector('circle')!.namespaceURI).toBe('http://www.w3.org/2000/svg')
    }
    finally {
      await dispose()
    }
  })

  const mount19 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst shown = signal(true)\nconst value = new Promise<string>(done => (globalThis as { resolveValue?: (value: string) => void }).resolveValue = done)\n---\nbutton(onClick={() => shown.set(false)}) Hide\ndiv\n  if shown()\n    await value\n      p.wait Waiting\n    then text\n      p.text {text}\n',
  })

  it('drop an await block whose branch went away before its value settled', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    let resolve: (value: string) => void = () => undefined
    const { root, dispose } = await mount19()

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

describe('transitions', () => {
  // Past two frames of happy-dom's, at about 16 ms each, and short of the 200 ms the transitions below take.
  // Once the effects a click queued have run, before any frame.
  const updated = async () => new Promise<void>(resolve => queueMicrotask(resolve))
  const twoFrames = async () => new Promise(resolve => setTimeout(resolve, 60))
  const done = async () => new Promise(resolve => setTimeout(resolve, 260))
  const STYLE = 'style="transition-duration: 200ms"'
  const toggled = (open: boolean, element: string) => `---\nimport { signal } from 'kay'\n\nconst open = signal(${open})\n---\nbutton(onClick={() => open.set(!open())}) Toggle\nif open()\n  ${element}\n`

  const mount20 = site({ 'main.kay': toggled(true, `p.panel(transition="fade" ${STYLE}) Hi`) })

  it('play an if branch out before it goes and in as it shows again, not as the island first renders', async () => {
    const { root, dispose } = await mount20()

    try {
      const panel = root.querySelector('.panel')!

      expect(panel.className).toBe('panel')
      root.querySelector('button')!.click()
      await updated()
      expect([panel.className, panel.isConnected]).toEqual(['panel fade-leave-from fade-leave-active', true])
      await twoFrames()
      expect([panel.className, panel.isConnected]).toEqual(['panel fade-leave-active fade-leave-to', true])
      await done()
      expect(panel.isConnected).toBe(false)

      root.querySelector('button')!.click()

      await updated()
      const shown = root.querySelector('.panel')!

      expect(shown.className).toBe('panel fade-enter-from fade-enter-active')
      await twoFrames()
      expect(shown.className).toBe('panel fade-enter-active fade-enter-to')
      await done()
      expect(shown.className).toBe('panel')
    }
    finally {
      await dispose()
    }
  })

  const mount21 = site({ 'main.kay': toggled(false, `p.panel(transition:enter="transition-opacity" transition:enter-from="opacity-0" transition:leave-to="opacity-0 scale-95" ${STYLE}) Hi`) })

  it('take the classes of each phase from its own attribute, as Tailwind writes them', async () => {
    const { root, dispose } = await mount21()

    try {
      root.querySelector('button')!.click()
      await updated()
      const panel = root.querySelector('.panel')!

      expect(panel.className).toBe('panel opacity-0 transition-opacity')
      await twoFrames()
      expect(panel.className).toBe('panel transition-opacity')
      root.querySelector('button')!.click()
      await updated()
      await twoFrames()
      expect(panel.className).toBe('panel opacity-0 scale-95')
      await done()
      expect(panel.isConnected).toBe(false)
    }
    finally {
      await dispose()
    }
  })

  const mount22 = site({
    'presets.ts': 'import type { TransitionClasses } from \'kay\'\n\nexport const fade: TransitionClasses = { enter: \'transition-opacity\', enterFrom: \'opacity-0\', leaveTo: \'opacity-0\' }\n',
    'main.kay': toggled(false, `p.panel(transition:leave-to="scale-95" transition={fade} ${STYLE}) Hi`).replace('---\n', '---\nimport { fade } from \'./presets\'\n'),
  })

  it('take the classes of each phase from a preset a module shares, the attributes adding to them', async () => {
    const { root, dispose } = await mount22()

    try {
      root.querySelector('button')!.click()
      await updated()
      const panel = root.querySelector('.panel')!

      expect(panel.className).toBe('panel opacity-0 transition-opacity')
      await twoFrames()
      expect(panel.className).toBe('panel transition-opacity')
      root.querySelector('button')!.click()
      await updated()
      await twoFrames()
      expect(panel.className).toBe('panel opacity-0 scale-95')
    }
    finally {
      await dispose()
    }
  })

  const mount23 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst items = signal(['a', 'b', 'c'])\n---\nbutton.drop(onClick={() => items.set(['a', 'c'])}) Drop\nbutton.add(onClick={() => items.set(['a', 'c', 'd'])}) Add\nul\n  for item of items()\n    li(transition="row" ${STYLE}) {item}\n`,
  })

  it('play a for row out as its item goes and the new rows in, the rows left in their order', async () => {
    const { root, dispose } = await mount23()

    try {
      const texts = () => [...root.querySelectorAll('li')].map(row => row.textContent)
      const b = root.querySelectorAll('li')[1]!

      expect([...root.querySelectorAll('li')].map(row => row.className)).toEqual(['', '', ''])
      root.querySelector<HTMLElement>('button.drop')!.click()
      await updated()
      expect([texts(), b.className]).toEqual([['a', 'b', 'c'], 'row-leave-from row-leave-active'])
      await done()
      expect(texts()).toEqual(['a', 'c'])

      root.querySelector<HTMLElement>('button.add')!.click()

      await updated()
      expect([texts(), root.querySelectorAll('li')[2]!.className]).toEqual([['a', 'c', 'd'], 'row-enter-from row-enter-active'])
    }
    finally {
      await dispose()
    }
  })

  const mount24 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst items = signal(['a'])\n---\nbutton(onClick={() => items.set([])}) Clear\nul\n  for item of items()\n    li(transition="row" ${STYLE}) {item}\n`,
  })

  it('play the last row out of a list its element holds alone, rather than clearing the element', async () => {
    const { root, dispose } = await mount24()

    try {
      root.querySelector('button')!.click()
      await updated()
      expect(root.querySelector('li')?.className).toBe('row-leave-from row-leave-active')
      await done()
      expect(root.querySelector('li')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  const mount25 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst items = signal(['a'])\n---\nbutton.clear(onClick={() => items.set([])}) Clear\nbutton.add(onClick={() => items.set(['b'])}) Add\nul\n  for item of items() key={item}\n    li.row {item}\n  else\n    li.empty(transition="fade" ${STYLE}) None\n`,
  })

  it('play a for fallback in once its rows went, and out as rows come back', async () => {
    const { root, dispose } = await mount25()

    try {
      root.querySelector<HTMLElement>('button.clear')!.click()
      await updated()
      const empty = root.querySelector('.empty')!

      expect(empty.className).toBe('empty fade-enter-from fade-enter-active')
      await done()
      root.querySelector<HTMLElement>('button.add')!.click()
      await updated()
      expect([empty.className, empty.isConnected, root.querySelector('.row')?.textContent]).toEqual(['empty fade-leave-from fade-leave-active', true, 'b'])
      await done()
      expect(empty.isConnected).toBe(false)
    }
    finally {
      await dispose()
    }
  })

  const mount26 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst items = signal(['a'])\nconst shown = (item: string) => {\n  if (item === 'bad')\n    throw new Error('bad')\n\n  return item\n}\n---\nbutton.bad(onClick={() => items.set(['a', 'b', 'bad'])}) Bad\nbutton.fix(onClick={() => items.set(['a', 'b2', 'c'])}) Fix\nul\n  for item, i of items() key={i}\n    li(transition="row" ${STYLE}) {shown(item)}\n`,
  })

  it('take out the rows a run that threw made, and play in only the rows the next one makes', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const { root, dispose } = await mount26()

    try {
      const rows = () => [...root.querySelectorAll('li')].map(row => [row.textContent, row.className])

      root.querySelector<HTMLElement>('button.bad')!.click()
      await updated()
      root.querySelector<HTMLElement>('button.fix')!.click()
      await updated()
      expect(rows()).toEqual([['a', ''], ['b', 'row-leave-from row-leave-active'], ['b2', 'row-enter-from row-enter-active'], ['c', 'row-enter-from row-enter-active']])
      await done()
      expect(rows()).toEqual([['a', ''], ['b2', ''], ['c', '']])
    }
    finally {
      errors.mockRestore()
      await dispose()
    }
  })

  const mount27 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst items = signal(['a', 'b', 'c'])\n---\nbutton.clear(onClick={() => items.set([])}) Clear\nbutton.add(onClick={() => items.set(['z'])}) Add\nul\n  for item of items() key={item}\n    li(transition="row" ${STYLE}) {item}\n`,
  })

  it('keep the rows leaving a list their element holds alone while the next rows enter', async () => {
    const { root, dispose } = await mount27()

    try {
      const rows = () => [...root.querySelectorAll('li')].map(row => [row.textContent, row.className])

      root.querySelector<HTMLElement>('button.clear')!.click()
      await updated()
      await twoFrames()
      root.querySelector<HTMLElement>('button.add')!.click()
      await updated()
      expect(rows()).toEqual([['a', 'row-leave-active row-leave-to'], ['b', 'row-leave-active row-leave-to'], ['c', 'row-leave-active row-leave-to'], ['z', 'row-enter-from row-enter-active']])
      await done()
      expect(rows()).toEqual([['z', '']])
    }
    finally {
      await dispose()
    }
  })

  const mount28 = site({
    'main.kay': `---\nimport { signal } from 'kay'\n\nconst broken = signal(false)\nconst read = () => {\n  if (broken())\n    throw new Error('broken')\n\n  return 'fine'\n}\n---\nbutton(onClick={() => broken.set(true)}) Break\ntry\n  p.content {read()}\ncatch error\n  p.caught(transition="fade" ${STYLE}) Oops\n`,
  })

  it('play a try\'s catch block in when what it renders throws after its first render', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const { root, dispose } = await mount28()

    try {
      expect(root.querySelector('.content')?.textContent).toBe('fine')
      root.querySelector('button')!.click()
      await updated()
      expect([root.querySelector('.content'), root.querySelector('.caught')?.className]).toEqual([null, 'caught fade-enter-from fade-enter-active'])
      await done()
      expect(root.querySelector('.caught')?.className).toBe('caught')
    }
    finally {
      errors.mockRestore()
      await dispose()
    }
  })

  const mount29 = site({ 'main.kay': toggled(true, `p.panel(transition="fade" ${STYLE}) Hi`) })

  it('skip both phases when the user asks for reduced motion', async () => {
    const matchMedia = spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList)
    const { root, dispose } = await mount29()

    try {
      root.querySelector('button')!.click()
      await updated()
      expect(root.querySelector('.panel')).toBeNull()
      root.querySelector('button')!.click()
      await updated()
      expect(root.querySelector('.panel')!.className).toBe('panel')
    }
    finally {
      matchMedia.mockRestore()
      await dispose()
    }
  })

  const mount30 = site({ 'main.kay': toggled(true, `p.panel(transition="fade" ${STYLE}) Hi`) })

  it('removes a leaving element at once in a hidden tab, which draws no frames to play it in', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    const { root, dispose } = await mount30()

    try {
      root.querySelector('button')!.click()
      await updated()
      expect(root.querySelector('.panel')).toBeNull()
    }
    finally {
      // The document's own getter, on its prototype, shows again.
      delete (document as { hidden?: boolean }).hidden
      await dispose()
    }
  })
})

describe('slots with parameters', () => {
  const mount31 = site({
    'rows.kay': '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T) => JSX.Element }>()\n---\nul\n  for item of items key={item}\n    | {row(item)}\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport Rows from \'./rows.kay\'\n\nconst names = signal([\'a\'])\nconst mark = signal(\'!\')\n---\nbutton(onClick={() => {\n  names.set([\'a\', \'b\'])\n  mark.set(\'?\')\n}}) Grow\nRows(items={names()})\n  @row(name)\n    li.row {name}{mark()}\n',
  })

  it('render a row per item the component passes, following its list and the parent\'s signals', async () => {
    const { root, dispose } = await mount31()

    try {
      root.querySelector('button')!.click()
      await settle()
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['a?', 'b?'])
    }
    finally {
      await dispose()
    }
  })
})

describe('named slots', () => {
  const mount32 = site({
    'card.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { items, actions, row } = props<{ items: string[], actions?: JSX.Element, row?: (item: string, index: number) => JSX.Element }>()\n---\nheader\n  slot actions\n    | No actions\nul\n  for item, i of items key={i}\n    slot row(item, i)\n      li {item}\nslot\n  p Empty\n',
    'main.kay': '---\nimport { signal } from \'kay\'\nimport Card from \'./card.kay\'\n\nconst names = signal([\'a\'])\n---\nbutton#grow(onClick={() => names.set([\'a\', \'b\'])}) Grow\nCard(items={names()})\n  @row(name, i)\n    li.row {i}: {name}\n',
  })

  it('render the block prop they name as it comes and goes, the lines under them standing in for it', async () => {
    const { root, dispose } = await mount32()

    try {
      root.querySelector<HTMLButtonElement>('#grow')!.click()
      await settle()
      expect([...root.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['0: a', '1: b'])
    }
    finally {
      await dispose()
    }
  })
})

describe('template consts', () => {
  const mount33 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(1)\n---\nconst double = n * 2\nbutton#up(onClick={() => n.set(c => c + 1)}) {double}\ndiv\n  p\n    const label = \'p\' + n\n    b {label}\n    i(title={label}) {double}\n  span\n    const label = \'s\' + double\n    | {label}\nif n > 1\n  const { big } = { big: n * 10 }\n  em {big}\n',
  })

  it('follow what they read as memos, in an element\'s content as in a block, two elements of one template declaring the same name', async () => {
    const { root, dispose } = await mount33()

    try {
      const read = () => [root.querySelector('#up')!.textContent, root.querySelector('b')!.textContent, root.querySelector('i')!.getAttribute('title'), root.querySelector('span')!.textContent, root.querySelector('em')?.textContent]
      const bold = root.querySelector('b')

      root.querySelector<HTMLButtonElement>('#up')!.click()
      await settle()
      expect(read()).toEqual(['4', 'p2', 'p2', 's4', '20'])
      expect(root.querySelector('b')).toBe(bold)
    }
    finally {
      await dispose()
    }
  })
})

describe('match blocks', () => {
  const mount34 = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst tab = signal(\'gone\')\nlet reads = 0\nconst read = () => (reads++, tab())\n---\nbutton#next(onClick={() => tab.set(tab() === \'gone\' ? \'draft\' : \'live\')}) next\nmatch read()\n  when \'draft\'\n    p.draft Draft\n  when \'live\', \'scheduled\'\n    p.live Live\n  else\n    p.other Unknown {reads}\n',
  })

  it('render the first when holding the subject, else the else, and follow the subject reading it once', async () => {
    const { root, dispose } = await mount34()

    try {
      expect(root.querySelector('p.other')!.textContent).toBe('Unknown 1')
      root.querySelector<HTMLButtonElement>('#next')!.click()
      await settle()
      expect(root.querySelector('p')!.className).toBe('draft')
      root.querySelector<HTMLButtonElement>('#next')!.click()
      await settle()
      expect(root.querySelectorAll('p')).toHaveLength(1)
      expect(root.querySelector('p')!.className).toBe('live')
    }
    finally {
      await dispose()
    }
  })
})

describe('bind:value on a number input', () => {
  const mountNumber = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst n = signal<number>(5)\n---\ninput#num(type="number" bind:value={n})\ninput#range(type="range" min="0" max="10" bind:value={n})\np#out {n()}\n' })

  it('keeps the signal\'s last number while the input is empty', async () => {
    const { root, dispose } = await mountNumber()
    const input = root.querySelector<HTMLInputElement>('#num')!
    const output = root.querySelector('#out')!
    const type = async (value: string) => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    }

    try {
      expect(input.value).toBe('5')
      await type('7')
      expect(output.textContent).toBe('7')
      await type('')
      expect(output.textContent).toBe('7')
      await type('8.5')
      expect(output.textContent).toBe('8.5')
    }
    finally {
      await dispose()
    }
  })
})

describe('the live reload script', () => {
  it('swaps the stylesheets when the server comes back running the same code, and reloads on any other change or a page that fails', async () => {
    const script = (/<script>([\s\S]*)<\/script>/).exec(LIVE_RELOAD)![1]!
    const meta = (/<meta name="kay-boot" content="([^"]+)">/).exec(LIVE_RELOAD)!
    const boot = meta[1]!
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
    document.head.innerHTML = `${meta[0]}<link rel="stylesheet" href="/_kay/app-1.css"><link rel="stylesheet" href="/theme.css">`
    // The id stays out of the script, which then reads the same on every server.
    expect(script).not.toContain(boot)

    try {
      // eslint-disable-next-line no-new-func -- runs the inline script a dev page carries
      (new Function(script) as () => void)()
      // A page without the page swap keeps the server render it loaded with.
      await onBoot({ data: `${boot} 3` })
      expect(fetched).toEqual(['http://localhost/page'])

      await onBoot({ data: 'next 3' })
      expect(fetched).toEqual(['http://localhost/page', 'http://localhost/page'])
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

  it('connects again every 10 ms for a restart\'s length, then less often down to four times a second, one connection open at a time', async () => {
    const script = (/<script>([\s\S]*)<\/script>/).exec(LIVE_RELOAD)![1]!
    const sources: { closed: boolean, onerror?: () => void, boot?: (event: { data: string }) => void }[] = []
    const delays: number[] = []
    const due: (() => void)[] = []
    const Source = class {
      closed = false
      onerror?: () => void
      boot?: (event: { data: string }) => void
      constructor() {
        sources.push(this)
      }

      close() {
        this.closed = true
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        if (name === 'boot')
          this.boot = listener
      }
    }
    const fail = (times: number) => {
      for (let time = 0; time < times; time++) {
        sources.at(-1)!.onerror!()
        due.shift()!()
      }
    }

    // eslint-disable-next-line no-new-func -- runs the inline script a dev page carries
    ;(new Function('EventSource', 'setTimeout', script) as (source: typeof Source, timeout: (run: () => void, delay: number) => void) => void)(Source, (run, delay) => {
      delays.push(delay)
      due.push(run)
    })
    fail(56)

    expect(delays.slice(48)).toEqual([10, 10, 20, 40, 80, 160, 250, 250])
    expect(sources.filter(source => !source.closed)).toHaveLength(1)

    // A server answering starts the count over; running other code than the page, it reloads it.
    const reload = spyOn(location, 'reload').mockImplementation(() => undefined)

    try {
      sources.at(-1)!.boot!({ data: 'next next' })
      fail(1)

      expect(delays.at(-1)).toBe(10)
      expect(sources.filter(source => !source.closed)).toHaveLength(1)
      await Bun.sleep(0)
      expect(reload).toHaveBeenCalledTimes(1)
    }
    finally {
      reload.mockRestore()
    }
  })
})

describe('actions called from the browser', () => {
  const mount35 = site({
    'page.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String() }), ({ title }) => title)\n---\np Page\n',
    'main.kay': '---\nimport { add } from \'./page.kay\'\n---\nbutton(disabled={add.pending()} onClick={() => void add({ title: \'x\' })}) Add\n',
  })

  it('read as pending while a call is in flight', async () => {
    let respond: (response: Response) => void = () => undefined
    const fetchStub = spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise<Response>((resolve) => {
      respond = resolve
    })) as unknown as typeof fetch)
    const { root, dispose } = await mount35()

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

describe('the dev patch', () => {
  const page = (body: string, head = '<title>Home</title>') => `<!doctype html><html lang="en"><head>${head}<script>new EventSource("/_kay/dev/events")</script></head><body>${body}</body></html>`
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

  it('changes only what the server render changed, leaving what scripts did to the rest of the page', () => {
    const before = page('<h1>Title</h1><div class="bar" id="a"></div><p class="note">Old</p><footer>End</footer>')
    const live = parse(before)
    const bar = live.querySelector('.bar')!
    const note = live.querySelector('p')!

    bar.classList.add('in-view')
    note.classList.add('seen')

    const after = page('<h1>Title</h1><div class="bar" id="a"></div><p class="note wide">New</p><footer>End</footer>', '<title>Next</title>')

    expect(patch(parse(before), parse(after), live)).toBe(true)
    expect(live.querySelector('.bar')).toBe(bar)
    expect(bar.className).toBe('bar in-view')
    expect(live.querySelector('p')).toBe(note)
    expect(note.className).toBe('note seen wide')
    expect(note.textContent).toBe('New')
    expect(live.title).toBe('Next')
  })

  it('leaves the live reload\'s boot id to it, the restarted server\'s render naming another', () => {
    const before = page('<p>Text</p>', '<title>Home</title><meta name="kay-boot" content="a">')
    const live = parse(before)

    expect(patch(parse(before), parse(page('<p>Text</p>', '<title>Home</title><meta name="kay-boot" content="b">')), live)).toBe(true)
    expect(live.querySelector('meta[name=kay-boot]')!.getAttribute('content')).toBe('a')
  })

  it('replaces the dev tool\'s request block, which differs on every render, rather than loading the page fully', () => {
    const block = (ms: number) => `<title>Home</title><script type="application/json" id="kay-dev-request">{"loads":[{"ms":${ms}}]}</script>`
    const before = page('<p>Text</p>', block(1))
    const live = parse(before)

    expect(patch(parse(before), parse(page('<p>New</p>', block(2))), live)).toBe(true)
    expect(live.getElementById('kay-dev-request')!.textContent).toBe('{"loads":[{"ms":2}]}')
    expect(live.body.innerHTML).toBe('<p>New</p>')
  })

  it('removes an attribute and a class the server dropped, and inserts and removes nodes between the common ends', () => {
    const before = page('<h1>Title</h1><p class="a b" hidden>One</p><p>Two</p><footer>End</footer>')
    const live = parse(before)

    live.querySelector('p')!.classList.add('script')

    expect(patch(parse(before), parse(page('<h1>Title</h1><p class="a">One</p><footer>End</footer>')), live)).toBe(true)
    expect(live.body.innerHTML).toBe('<h1>Title</h1><p class="a script">One</p><footer>End</footer>')

    const grown = page('<h1>Title</h1><p class="a">One</p><aside>New</aside><footer>End</footer>')

    expect(patch(parse(page('<h1>Title</h1><p class="a">One</p><footer>End</footer>')), parse(grown), live)).toBe(true)
    expect(live.body.innerHTML).toBe('<h1>Title</h1><p class="a script">One</p><aside>New</aside><footer>End</footer>')
  })

  it('asks for a reload when the change cannot be applied in place', () => {
    const base = '<p>Text</p><slot data-component="a" data-props="{}"><b>0</b></slot>'
    const cases: [string, string, string?][] = [
      [base, base.replace('"{}"', '"{&quot;n&quot;:1}"')],
      [base, `${base}<slot data-component="b"></slot>`],
      [base, '<p>Text</p>'],
      [base, `${base}<script>run()</script>`],
      [base, base.replace('Text', 'Other'), `${base}<div></div>`],
      ['<p>Text</p><!--kay-await:1-->x<!--/kay-await:1-->', '<p>Other</p><!--kay-await:1-->x<!--/kay-await:1-->'],
    ]

    for (const [before, after, live] of cases) {
      const old = parse(page(before))
      const next = parse(page(after))

      expect(patch(old, next, parse(page(live ?? before)))).toBe(false)
    }

    const lang = page('<p>Text</p>')

    expect(patch(parse(lang), parse(lang.replace('lang="en"', 'lang="fr"')), parse(lang))).toBe(false)
    expect(patch(parse(lang), parse(page('<p>Text</p>', '<title>Home</title><script type="module" src="/entry.js"></script>')), parse(lang))).toBe(false)
    // A live page that lost a node its render had.
    expect(patch(parse(page('<p>a</p><p>b</p>')), parse(page('<p>a</p><p>c</p>')), parse(page('<p>a</p>')))).toBe(false)
  })

  it('leaves the stylesheets to the live reload', () => {
    const { happyDOM } = globalThis as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }
    const before = page('<p>Text</p>', '<link rel="stylesheet" href="/app-1.css">')

    happyDOM.settings.disableCSSFileLoading = true

    try {
      const live = parse(before)

      expect(patch(parse(before), parse(page('<p>Other</p>', '<link rel="stylesheet" href="/app-2.css">')), live)).toBe(true)
      expect(live.querySelector('link')!.getAttribute('href')).toBe('/app-1.css')
      expect(live.querySelector('p')!.textContent).toBe('Other')
    }
    finally {
      happyDOM.settings.disableCSSFileLoading = false
    }
  })
})

describe('a site under a base', () => {
  const mount36 = site({
    'main.kay': '---\nimport { signal, withBase } from \'kay\'\n\nconst slug = signal(\'dracula\')\n---\na(href={`/books/${slug()}`}) book\na(href="/about") about\nimg(alt="" srcset="/a.png 1x, /b.png 2x")\nsvg\n  use(xlink:href="/s.svg#a")\na(href={withBase(\'/kept\')}) kept\na(href="https://example.com/x") away\na(href="#top") top\nbutton(onClick={() => slug.set(\'emma\')}) next\n',
  }, true)

  it('puts what an island renders in the browser under it, as the server does, leaving a path already under it and another site\'s URL alone', async () => {
    const meta = document.createElement('meta')

    meta.name = 'kay-base'
    meta.content = '/shelf'
    document.head.append(meta)

    const { root, dispose } = await mount36()

    try {
      const hrefs = () => [...root.querySelectorAll('a')].map(link => link.getAttribute('href'))

      expect(hrefs()).toEqual(['/shelf/books/dracula', '/shelf/about', '/shelf/kept', 'https://example.com/x', '#top'])
      expect(root.querySelector('img')!.getAttribute('srcset')).toBe('/shelf/a.png 1x, /shelf/b.png 2x')

      expect(root.querySelector('use')!.getAttribute('xlink:href')).toBe('/shelf/s.svg#a')

      root.querySelector('button')!.click()
      await settle()
      expect(hrefs()[0]).toBe('/shelf/books/emma')
    }
    finally {
      meta.remove()
      await dispose()
    }
  })
})

describe('a form submitted in the browser', () => {
  const mountForm = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst answers: (() => void)[] = []\n\nfunction send(event: SubmitEvent) {\n  event.preventDefault()\n  count.set(count() + 1)\n\n  return new Promise<void>(resolve => answers.push(resolve))\n}\n---\nform(onSubmit={send})\n  button#go(type="submit") Send\n  button#other(type="button") Other\n  input(type="submit" value="Input")\nbutton#settle(type="button" onClick={() => answers.shift()?.()}) settle\n',
  })

  it('is aria-busy with its submit buttons while an onSubmit answers a promise, however many are pending', async () => {
    const { root, dispose } = await mountForm()

    try {
      const form = root.querySelector('form')!
      const busy = () => [form, root.querySelector('#go'), root.querySelector('#other')].map(element => element!.getAttribute('aria-busy'))

      form.requestSubmit()
      form.requestSubmit()
      await settle()
      expect(busy()).toEqual(['true', 'true', null])

      root.querySelector<HTMLElement>('#settle')!.click()
      await settle()
      expect(busy()).toEqual(['true', 'true', null])

      root.querySelector<HTMLElement>('#settle')!.click()
      await settle()
      expect(busy()).toEqual([null, null, null])
    }
    finally {
      await dispose()
    }
  })

  // Alone, so no earlier test has loaded the hold into a runtime this one shares.
  const mountSpread = site({
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst answers: (() => void)[] = []\nconst mode = signal(0)\nconst log = signal(\'\')\nconst on = (name: string) => (event: SubmitEvent) => {\n  event.preventDefault()\n  log.set(log() + name)\n\n  return new Promise<void>(resolve => answers.push(resolve))\n}\nconst first = on(\'a\')\nconst second = on(\'b\')\n---\nform({...{ get onSubmit() { return mode() === 0 ? first : mode() === 1 ? second : undefined } }})\n  button#go(type="submit") Send\nbutton#settle(type="button" onClick={() => answers.shift()?.()}) settle\nbutton#next(type="button" onClick={() => mode.set(mode() + 1)}) next\np#log {log()}\n',
  }, true)

  it('holds an onSubmit a spread on a form gives, replaces it and drops it', async () => {
    const { root, dispose } = await mountSpread()

    try {
      const form = root.querySelector('form')!
      const busy = () => [form, root.querySelector('#go')].map(element => element!.getAttribute('aria-busy'))
      const click = async (id: string) => {
        root.querySelector<HTMLElement>(id)!.click()
        await settle()
      }

      form.requestSubmit()
      await settle()
      expect(busy()).toEqual(['true', 'true'])

      await click('#settle')
      expect(busy()).toEqual([null, null])

      await click('#next')
      form.requestSubmit()
      await settle()
      expect(root.querySelector('#log')!.textContent).toBe('ab')
      expect(busy()).toEqual(['true', 'true'])
      await click('#settle')

      await click('#next')
      form.requestSubmit()
      await settle()
      expect(root.querySelector('#log')!.textContent).toBe('ab')
      expect(busy()).toEqual([null, null])
    }
    finally {
      await dispose()
    }
  })

  // Each alone, so the dynamic tag is all that loads the hold into its runtime.
  const dynamicForm = (tag: string) => `---\nconst { as: Tag = 'form' } = props<{ as?: string }>()\nconst answers: (() => void)[] = []\n\nfunction send(event: SubmitEvent) {\n  event.preventDefault()\n\n  return new Promise<void>(resolve => answers.push(resolve))\n}\n---\n${tag}\n  button#go(type="submit") Send\nbutton#settle(type="button" onClick={() => answers.shift()?.()}) settle\n`
  const mountDynamic = site({ 'main.kay': dynamicForm('Tag(onSubmit={send})') }, true)
  const mountDynamicSpread = site({ 'main.kay': dynamicForm('Tag({...{ onSubmit: send }})') }, true)

  for (const [how, mount] of [['written', mountDynamic], ['spread', mountDynamicSpread]] as const) {
    it(`holds an onSubmit ${how} on a dynamic tag naming a form`, async () => {
      const { root, dispose } = await mount()

      try {
        const form = root.querySelector('form')!
        const busy = () => [form, root.querySelector('#go')].map(element => element!.getAttribute('aria-busy'))

        form.requestSubmit()
        await settle()
        expect(busy()).toEqual(['true', 'true'])

        root.querySelector<HTMLElement>('#settle')!.click()
        await settle()
        expect(busy()).toEqual([null, null])
      }
      finally {
        await dispose()
      }
    })
  }

  // bun test fails on any unhandled rejection whatever listens for it, so the rejection is observed in a process of its own.
  it('still reports an onSubmit that rejects, and is no longer aria-busy once it settled', async () => {
    const script = `
      import { Window } from 'happy-dom'
      const window = new Window()
      Object.assign(globalThis, { HTMLFormElement: window.HTMLFormElement, HTMLButtonElement: window.HTMLButtonElement })
      const { listenSubmit } = await import(${JSON.stringify(join(import.meta.dir, '../src/runtime/form-hold.ts'))})
      const reasons = []
      process.on('unhandledRejection', reason => reasons.push(reason.message))
      window.document.body.innerHTML = '<form><button type="submit"></button></form>'
      const form = window.document.querySelector('form')
      listenSubmit(form, 'onSubmit', () => Promise.reject(new Error('refused')))
      form.requestSubmit()
      await Bun.sleep(20)
      console.log(JSON.stringify({ reasons, busy: [form, form.querySelector('button')].map(element => element.getAttribute('aria-busy')) }))
    `
    const run = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

    expect(err).toBe('')
    expect(JSON.parse(out)).toEqual({ reasons: ['refused'], busy: [null, null] })
  })
})
