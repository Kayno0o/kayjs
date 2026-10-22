import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { element, spreadWith } from '../src/runtime/html'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

interface Site {
  files: Record<string, string>
  main?: (props: object) => unknown
  render?: (fn: () => unknown, element: Element) => () => void
}

const sites: Site[] = []
let folder = ''

// Declares a case, and hands back what mounts it in a fresh element.
function site(files: Site['files']): () => Promise<{ root: HTMLElement, dispose: () => Promise<void> }> {
  const declared: Site = { files }

  sites.push(declared)

  return async () => {
    const root = document.createElement('div')

    document.body.append(root)

    const unmount = declared.render!(() => declared.main!({}), root)

    return { root, dispose: async () => unmount() }
  }
}

beforeAll(async () => {
  folder = await scratchDir('bind-elements-')
  await Bun.write(join(folder, 'entry.ts'), `import { render } from 'kay/dom'\n${sites.map((_, index) => `import Main${index} from './${index}/main.kay'`).join('\n')}\n\nexport const mains = [${sites.map((_, index) => `Main${index}`).join(', ')}]\nexport { render }\n`)
  await Promise.all(sites.flatMap((declared, index) => Object.entries(declared.files).map(async ([name, text]) => Bun.write(join(folder, String(index), name), text))))

  const build = await Bun.build({ entrypoints: [join(folder, 'entry.ts')], outdir: join(folder, 'out'), target: 'browser', plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  const module = await import(build.outputs[0]!.path) as { mains: NonNullable<Site['main']>[], render: NonNullable<Site['render']> }

  GlobalRegistrator.register()

  for (const [index, declared] of sites.entries()) {
    declared.main = module.mains[index]!
    declared.render = module.render
  }
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(folder, { recursive: true, force: true })
})

describe('bind:group, bind:open and bind:files', () => {
  const mountMore = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst pick = signal(\'b\')\nconst tags = signal<string[]>([\'x\'])\nconst open = signal(false)\nconst files = signal<FileList | null>(null)\n---\ninput#ra(type="radio" name="p" value="a" bind:group={pick})\ninput#rb(type="radio" name="p" value="b" bind:group={pick})\ninput#tx(type="checkbox" value="x" bind:group={tags})\ninput#ty(type="checkbox" value="y" bind:group={tags})\ndetails#d(bind:open={open})\n  summary S\ndialog#dg(bind:open={open}) hi\ninput#f(type="file" bind:files={files})\nbutton#reset(onClick={() => { pick.set(\'a\'); tags.set([]); open.set(true); files.set(null) }}) reset\np#out {pick()} {tags().join(\',\')} {open() ? \'open\' : \'shut\'} {files()?.length ?? \'none\'}\n' })

  it('follows the radios, the checkboxes, the details and the dialog both ways', async () => {
    const { root, dispose } = await mountMore()
    const get = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!
    const output = root.querySelector('#out')!
    const details = root.querySelector<HTMLDetailsElement>('#d')!
    const dialog = root.querySelector<HTMLDialogElement>('#dg')!

    try {
      expect([get('ra').checked, get('rb').checked, get('tx').checked, get('ty').checked]).toEqual([false, true, true, false])
      expect(output.textContent).toBe('b x shut none')
      get('ra').checked = true
      get('ra').dispatchEvent(new Event('change', { bubbles: true }))
      get('ty').checked = true
      get('ty').dispatchEvent(new Event('change', { bubbles: true }))
      get('tx').checked = false
      get('tx').dispatchEvent(new Event('change', { bubbles: true }))
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await settle()
      expect(output.textContent).toBe('a y open none')
      expect(dialog.open).toBe(true)
      dialog.close()
      dialog.dispatchEvent(new Event('close'))
      await settle()
      expect(output.textContent).toBe('a y shut none')
      expect(details.open).toBe(false)
      root.querySelector<HTMLButtonElement>('#reset')!.click()
      await settle()
      expect(output.textContent).toBe('a  open none')
      expect([get('ra').checked, get('tx').checked, get('ty').checked, details.open, dialog.open]).toEqual([true, false, false, true, true])
    }
    finally {
      await dispose()
    }
  })

  it('hands the picked files to the signal', async () => {
    const { root, dispose } = await mountMore()
    const input = root.querySelector<HTMLInputElement>('#f')!

    try {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.txt')] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(root.querySelector('#out')!.textContent).toContain(' shut 1')
      root.querySelector<HTMLButtonElement>('#reset')!.click()
      await settle()
      expect(root.querySelector('#out')!.textContent).toContain(' none')
      expect(input.value).toBe('')
    }
    finally {
      await dispose()
    }
  })
})

describe('style:prop and event modifiers', () => {
  const mountDirectives = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst color = signal(\'red\')\nconst gap = signal<number | null>(4)\nconst log = signal(\'\')\nconst add = (letter: string) => log.set(log() + letter)\n---\np#s(style="top:1px" style:color={color()} style:--gap={gap()}) x\np#plain(style:width={gap() === null ? null : gap() + \'px\'}) y\nform#f(onSubmit|preventDefault={() => add(\'f\')}) z\ndiv#outer(onClick={() => add(\'o\')})\n  button#inner(onClick|stopPropagation={() => add(\'i\')}) i\n  button#both(onClick|preventDefault|stopPropagation={e => add(String(e.defaultPrevented))}) b\n  button#plainbutton(onClick={() => add(\'p\')}) p\nbutton#toggle(onClick={() => { color.set(\'blue\'); gap.set(null) }}) t\np#out {log()}\n' })

  it('merges style:prop into the style, follows the signals and drops a null value', async () => {
    const { root, dispose } = await mountDirectives()
    const style = (id: string) => root.querySelector(`#${id}`)!.getAttribute('style')

    try {
      expect(style('s')).toBe('top:1px;color:red;--gap:4')
      expect(style('plain')).toBe('width:4px')
      root.querySelector<HTMLButtonElement>('#toggle')!.click()
      await settle()
      expect(style('s')).toBe('top:1px;color:blue')
      expect(style('plain')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  it('calls the event methods before the handler, and stops a click at the element', async () => {
    const { root, dispose } = await mountDirectives()
    const out = root.querySelector('#out')!

    try {
      const submit = new Event('submit', { bubbles: true, cancelable: true })

      root.querySelector('#f')!.dispatchEvent(submit)
      await settle()
      expect(submit.defaultPrevented).toBe(true)
      root.querySelector<HTMLButtonElement>('#inner')!.click()
      await settle()
      expect(out.textContent).toBe('fi')
      root.querySelector<HTMLButtonElement>('#both')!.click()
      root.querySelector<HTMLButtonElement>('#plainbutton')!.click()
      await settle()
      expect(out.textContent).toBe('fitruepo')
    }
    finally {
      await dispose()
    }
  })
})

describe('style:prop and bind: next to a spread', () => {
  const mountSpreads = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst color = signal(\'red\')\nconst text = signal(\'a\')\nconst on = signal(false)\nconst pick = signal(\'b\')\nconst log = signal(\'\')\nconst carried = { style: \'top:1px\', onInput: () => log.set(log() + \'s\') }\n---\ninput#t(bind:value={text} style:color={color()} {...carried})\ninput#c(type="checkbox" bind:checked={on} {...carried})\ninput#ra(type="radio" name="p" value="a" bind:group={pick} {...carried})\ninput#rb(type="radio" name="p" value="b" bind:group={pick} {...carried})\nbutton#toggle(onClick={() => { color.set(\'blue\'); text.set(\'z\'); on.set(true); pick.set(\'a\') }}) t\np#out {text()} {on() ? \'on\' : \'off\'} {pick()} {log()}\n' })

  it('merges the style props into the style a spread brings, and binds beside its handler', async () => {
    const { root, dispose } = await mountSpreads()
    const text = root.querySelector<HTMLInputElement>('#t')!
    const output = root.querySelector('#out')!

    try {
      expect(text.getAttribute('style')).toBe('top:1px;color:red')
      expect(text.value).toBe('a')
      text.value = 'typed'
      text.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      expect(output.textContent).toBe('typed off b s')

      const box = root.querySelector<HTMLInputElement>('#c')!

      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(output.textContent).toContain('typed on b')

      root.querySelector<HTMLInputElement>('#ra')!.checked = true
      root.querySelector<HTMLInputElement>('#ra')!.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
      expect(output.textContent).toContain('typed on a')
      root.querySelector<HTMLButtonElement>('#toggle')!.click()
      await settle()
      expect(text.getAttribute('style')).toBe('top:1px;color:blue')
      expect(text.value).toBe('z')
      expect(box.checked).toBe(true)
      expect(root.querySelector<HTMLInputElement>('#rb')!.checked).toBe(false)
    }
    finally {
      await dispose()
    }
  })

  it('renders them on the server', () => {
    const sources = spreadWith([{ style: 'top:1px', onInput: () => undefined }], [['color', 'red']], [['value', () => 'v', 'onInput', () => undefined]])

    expect(element('input', sources).t).toBe('<input value="v" style="top:1px;color:red">')
    expect(element('input', spreadWith([{}], [['color', null]])).t).toBe('<input>')
  })
})

describe('ref returning a cleanup', () => {
  const mountSpread = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst n = signal(0)\nconst log: string[] = ((globalThis as any).refLog ??= [])\nconst track = (el: HTMLElement) => {\n  log.push(\'attach \' + el.id)\n  return () => log.push(\'detach \' + el.id)\n}\nconst extra = { ref: track }\n---\nbutton#t(onClick={() => n.set(n() + 1)}) go\np#s(title={String(n())} {...extra}) s\n' })

  const mountRef = site({ 'main.kay': '---\nimport { signal } from \'kay\'\nconst on = signal(true)\nconst log: string[] = ((globalThis as any).refLog ??= [])\nconst track = (el: HTMLElement) => {\n  log.push(\'attach \' + el.id)\n  return () => log.push(\'detach \' + el.id)\n}\n---\nbutton#t(onClick={() => on.set(!on())}) toggle\nif on()\n  p#a(ref={track}) a\n' })

  it('runs the cleanup when the element goes away', async () => {
    const log: string[] = ((globalThis as unknown as { refLog?: string[] }).refLog ??= [])

    log.length = 0

    const { root, dispose } = await mountRef()

    try {
      expect(log).toEqual(['attach a'])
      root.querySelector<HTMLButtonElement>('#t')!.click()
      await settle()
      expect(log).toEqual(['attach a', 'detach a'])
    }
    finally {
      await dispose()
    }
  })

  it('keeps a spread element\'s behaviour attached while another prop changes, and lets go when the component goes', async () => {
    const log: string[] = ((globalThis as unknown as { refLog?: string[] }).refLog ??= [])

    log.length = 0

    const { root, dispose } = await mountSpread()

    expect(log).toEqual(['attach s'])
    root.querySelector<HTMLButtonElement>('#t')!.click()
    await settle()
    expect(root.querySelector('#s')!.getAttribute('title')).toBe('1')
    expect(log).toEqual(['attach s'])
    await dispose()
    expect(log).toEqual(['attach s', 'detach s'])
  })
})
