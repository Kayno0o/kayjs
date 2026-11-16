import { resolve } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { registerLoader } from '../src/server/loader'
import { mountComponent, settle } from '../src/test'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const component = (body: string, props = 'items, size = \'md\'') => `---\nimport { signal, memo } from 'kay'\n\nconst { ${props} } = props<{ items: string[], size?: string, initialOpen?: boolean, onPick?: () => void }>()\nconst count = signal(1)\n${body}\n---\nbutton(onClick={() => count = count() + 1}) {count()}\n`
const code = (body: string, output?: 'dom' | 'html', props?: string) => compileKay(component(body, props), 'test.kay', output ? { output } : { check: true }).tsx

describe('a top-level const derived from a prop or a signal', () => {
  it('is a memo read through a call in the browser, where a prop is read off the props object', () => {
    const dom = code('const last = items.length - 1\nconst twice = count() * 2\nconst show = () => [last, twice]', 'dom')

    expect(dom).toContain('const last = KayMemo(() => (__props.items.length - 1))')
    expect(dom).toContain('const twice = KayMemo(() => (count() * 2))')
    expect(dom).toContain('const show = () => [last(), twice()]')
  })

  it('stays a plain value on the server, which renders once, and in the type check', () => {
    for (const output of ['html', undefined] as const) {
      const plain = code('const last = items.length - 1\nconst twice = count() * 2\nconst show = () => [last, twice]', output)

      expect(plain).not.toContain('KayMemo(')
      expect(plain).toContain('const last = __props.items.length - 1')
      expect(plain).toContain('const show = () => [last, twice]')
    }
  })

  it('is read as a call inside an event handler, the template and a later derivation', () => {
    const dom = code('const last = items.length - 1\nconst next = last + 1\nconst log = () => console.log(last)', 'dom')

    expect(dom).toContain('const next = KayMemo(() => (last() + 1))')
    expect(dom).toContain('const log = () => console.log(last())')

    const handler = compileKay('---\nimport { signal } from \'kay\'\nconst { n } = props<{ n: number }>()\nconst seen = signal(0)\nconst twice = n * 2\n---\nbutton(onClick={() => seen = twice}) {twice}\n', 'test.kay', { output: 'dom' }).tsx

    expect(handler).toContain('seen.set(twice())')
  })

  it('follows a prop declared with a default or renamed, and a derived const handed on shorthand', () => {
    expect(code('const label = size.toUpperCase()', 'dom')).toContain('const label = KayMemo(() => ((__props.size !== undefined ? __props.size : \'md\').toUpperCase()))')
    expect(code('const label = heading.length', 'dom', 'items: heading')).toContain('const label = KayMemo(() => (__props.items.length))')

    const shorthand = compileKay('---\nconst { n } = props<{ n: number }>()\nconst twice = n * 2\nconst box = { twice }\n---\np {box.twice}\n', 'test.kay', { output: 'dom' }).tsx

    expect(shorthand).toContain('const box = KayMemo(() => ({ twice: twice() }))')
  })

  it('stays a plain value for a function, a read once on purpose, a value computed without reading either', () => {
    const dom = code('const fn = () => items.length\nconst fixed = 3\nconst mode = size === \'md\' ? 1 : 2\nconst made = make(items, size)\nconst start = initialOpen\nconst id = size ?? uid()\nconst show = () => [fn, fixed, mode, made, start, id]', 'dom', 'items, size, initialOpen')

    expect(dom).not.toContain('KayMemo(() => (')
    expect(dom).toContain('const fn = () => __props.items.length')
  })

  it('follows a props object read by name, and starts a signal from its first value', () => {
    expect(code('const first = signal(items.length)', 'dom')).toContain('const first = signal(__props.items.length)')

    const named = compileKay('---\nconst all = props<{ items: string[] }>()\nconst total = all.items.length\n---\np {total}\n', 'test.kay', { output: 'dom' }).tsx

    expect(named).toContain('const total = KayMemo(() => (all.items.length))')
  })

  it('does not call a const named like a module name a clash', () => {
    const result = compileKay('---\nconst { items } = props<{ items: string[] }>()\nconst test = items.length\n---\np {test}\n', 'test.kay', { output: 'dom' })

    expect(result.diagnostics.map(d => d.code)).not.toContain('name-clash')
  })

  it('leaves a const plain when the script writes a signal it reads later, and keeps it live when a handler writes', () => {
    const plain = code('const d = count() * 2\ncount = 5\nconst e = count() + 1\ncount.set(7)', 'dom')

    expect(plain).toContain('const d = count() * 2')
    expect(plain).toContain('const e = count() + 1')
    expect(code('const d = count() * 2\nconst go = () => count = 5', 'dom')).toContain('const d = KayMemo(() => (count() * 2))')
    expect(code('const go = () => count = 5\nconst d = count() * 2', 'dom')).toContain('const d = KayMemo(')
  })

  it('reads a derived const used as a component tag through its call', () => {
    const dom = compileKay('---\nimport Alpha from \'./alpha.kay\'\nimport Beta from \'./beta.kay\'\nconst { kind } = props<{ kind: string }>()\nconst Tag = kind === \'a\' ? Alpha : Beta\nconst Pick = ({ a: Alpha, b: Beta })[kind]\n---\nPick\n', 'test.kay', { output: 'dom' }).tsx

    expect(dom).toContain('KayDynamic(Pick(), ')
    expect(dom).toContain('const Pick = KayMemo(')
  })

  it('wraps an alias of a signal, and leaves a module fence and an export alone', () => {
    expect(code('const alias = count\nconst show = () => alias()()', 'dom')).toContain('const alias = KayMemo(() => (count))')

    const module = compileKay('--- module\nexport const base = 1\n---\n---\nconst { n } = props<{ n: number }>()\nconst twice = n * 2\n---\np {base} {twice}\n', 'test.kay', { output: 'dom' })

    expect(module.tsx).toContain('const base = 1')
    expect(module.tsx).not.toContain('const base = KayMemo')
    expect(compileKay('---\nconst { n } = props<{ n: number }>()\nexport const twice = n * 2\n---\np {n}\n', 'test.kay', { output: 'dom' }).diagnostics.length).toBeGreaterThan(0)
  })

  it('wraps an object and an array as the one value they are, read through the call', () => {
    const dom = code('const shape = { size, first: items[0] }\nconst copy = [...items]\nconst show = () => [shape.size, copy.length]', 'dom')

    expect(dom).toContain('const shape = KayMemo(() => ({ size: (__props.size !== undefined ? __props.size : \'md\'), first: __props.items[0] }))')
    expect(dom).toContain('const copy = KayMemo(() => ([...__props.items]))')
    expect(dom).toContain('[shape().size, copy().length]')
  })

  it('leaves a `let`, a destructuring, an `await` and a nested declaration as written, the lint naming them', () => {
    for (const body of ['let last = items.length\nconst show = () => last', 'const { length } = items\nconst show = () => length', 'const last = await items\nconst show = () => last', 'if (items.length)\n  var last = items.length\nconst show = () => last']) {
      const dom = code(body, 'dom')
      const diagnostics = compileKay(component(body), 'test.kay', { check: true, insideIsland: true }).diagnostics

      expect(dom).not.toContain('KayMemo(')
      expect(diagnostics.some(d => d.code === 'once-read-prop')).toBe(true)
    }
  })

  it('has the same text in dev, which inspects the source, and in the check', () => {
    const body = 'const last = items.length - 1\nconst show = () => last'

    expect(compileKay(component(body), 'test.kay', { output: 'dom', inspect: true }).tsx).toContain('KayMemo(() => (__props.items.length - 1))')
    expect(compileKay(component(body), 'test.kay', { check: true }).diagnostics.filter(d => d.code === 'once-read-prop')).toEqual([])
  })

  it('keeps the first value of one a `kay-allow once-read-prop` comment covers, on its line or in the file', () => {
    expect(code('// kay-allow once-read-prop: the first one is meant\nconst last = items.length - 1\nconst show = () => last', 'dom')).toContain('const last = __props.items.length - 1')
    expect(code('const last = items.length - 1 // kay-allow once-read-prop\nconst show = () => last', 'dom')).toContain('const last = __props.items.length - 1')
    expect(code('// kay-allow-file once-read-prop\nconst last = items.length - 1\nconst twice = count() * 2', 'dom')).not.toContain('KayMemo(() => (')
  })

  it('refuses a write to it, which it has no signal to take', () => {
    const messages = compileKay(component('const last = items.length\nlast = 3'), 'test.kay', { output: 'dom' }).diagnostics.map(d => d.message)

    expect(messages).toContain('`last` is computed from a prop or a signal, so it cannot be reassigned')
  })
})

// A .kay file the test names by path, loaded through the loader so mountComponent finds the file it was built from.
async function imported(file: string): Promise<(props: Record<string, unknown>) => unknown> {
  await registerLoader(process.cwd())

  return ((await import(resolve(file))) as { default: (props: Record<string, unknown>) => unknown }).default
}

describe('in an island', () => {
  it('follows a prop the parent changes, a signal, a derivation of both and a handler reading it', async () => {
    const { root, unmount } = await mountComponent(await imported('tests/fixtures/mount/derived-parent.kay'))
    const text = (name: string) => root.querySelector(`.${name}`)!.textContent

    expect([text('twice'), text('triple'), text('both'), text('info'), text('describe'), text('mode'), text('snapshot')]).toEqual(['2', '3', '5', '2-x', '2:1', 'small', '1'])

    root.querySelector<HTMLButtonElement>('.up')!.click()
    root.querySelector<HTMLButtonElement>('.up')!.click()
    root.querySelector<HTMLButtonElement>('.up')!.click()
    root.querySelector<HTMLButtonElement>('.up')!.click()
    root.querySelector<HTMLButtonElement>('.up')!.click()
    await settle()

    // n is 6: the derivations follow it, a function reads the latest, the let keeps its first value, the test of a condition was a choice made once.
    expect([text('twice'), text('triple'), text('both'), text('info'), text('describe'), text('mode'), text('snapshot')]).toEqual(['12', '3', '15', '12-x', '12:6', 'small', '1'])

    root.querySelector<HTMLButtonElement>('.add')!.click()
    await settle()
    expect([text('triple'), text('both')]).toEqual(['6', '18'])

    root.querySelector<HTMLButtonElement>('.log')!.click()
    await settle()
    expect(text('seen')).toBe('12')
    unmount()
  })
})
