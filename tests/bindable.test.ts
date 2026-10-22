import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { signal } from '../src/runtime/core'
import { bindable } from '../src/runtime/internal'
import { flush, renderEffect, root } from '../src/runtime/reactive'
import { merge, omit } from '../src/runtime/values'

const PARENT = '---\nimport { signal } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst open = signal(false)\n---\nToggle(bind:open={open})\n'
const CHILD = '---\nimport { type Bindable } from \'kay\'\nconst { open } = props<{ open: Bindable<boolean> }>()\n---\nbutton(onClick={() => open = !open}) go\n'

function compile(source: string, output?: 'dom' | 'html') {
  return compileKay(source, 'test.kay', output ? { output } : { check: true })
}

describe('bind: on a component', () => {
  it('hands the child a getter and a setter in the browser and the value on the server', () => {
    expect(compile(PARENT, 'dom').tsx).toContain('{ get "open"() { return (open)() }, set "open"(kayValue) { (open).set(kayValue) } }')
    expect(compile(PARENT, 'html').tsx).toContain('{ "open": (open)() }')
  })

  it('makes the parent an island, naming the bind', () => {
    const result = compile('---\nimport { signal } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst open = signal(false)\n---\nToggle(bind:open={open})\n', 'dom')

    expect(result.island).toBeTruthy()
    expect(result.why).toContain('bind:open')
  })

  it('passes a Bindable prop of the parent on by name, through two levels', () => {
    const middle = '---\nimport { type Bindable } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst { open } = props<{ open: Bindable<boolean> }>()\n---\nToggle(bind:open={open})\n'

    expect(compile(middle, 'dom').tsx).toContain('{ get "open"() { return (__props.open) }, set "open"(kayValue) { __props["open"] = kayValue } }')
  })

  it('hands on the default of an optional Bindable prop, and writes the props object', () => {
    const middle = '---\nimport { type Bindable } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst { open = false } = props<{ open?: Bindable<boolean> | undefined }>()\n---\nToggle(bind:open={open})\n'

    expect(compile(middle, 'dom').tsx).toContain('{ get "open"() { return ((__props.open !== undefined ? __props.open : __default_0())) }, set "open"(kayValue) { __props["open"] = kayValue } }')
    expect(compile(middle, 'html').tsx).toContain('{ "open": ((__props.open !== undefined ? __props.open : __default_0())) }')
  })

  it('passes on the prop through the name of the props object', () => {
    const middle = '---\nimport { type Bindable } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst p = props<{ open: Bindable<boolean> }>()\n---\nToggle(bind:open={p.open})\n'

    expect(compile(middle, 'dom').tsx).toContain('{ get "open"() { return (p.open) }, set "open"(kayValue) { __props["open"] = kayValue } }')
  })

  it('reads and assigns the prop as a plain name, wrapping the props only where a prop is Bindable', () => {
    const dom = compile(CHILD, 'dom').tsx

    expect(dom).toContain('__props = KayBindable(__props, ["open"])')
    expect(dom).toContain('__props.open = !__props.open')
    expect(compile(CHILD, 'html').tsx).not.toContain('KayBindable')
    expect(compile(CHILD.replace('Bindable<boolean>', 'boolean').replace('import { type Bindable } from \'kay\'\n', ''), 'dom').tsx).not.toContain('KayBindable')
  })

  it('takes the name of a loop variable, a snippet parameter or a const for the value it is, not for the prop', () => {
    const child = (template: string) => `---\nimport { type Bindable, signal } from 'kay'\nimport Toggle from './Toggle.kay'\nconst { open } = props<{ open: Bindable<boolean> }>()\nconst flags = [signal(false)]\n---\n${template}`

    for (const template of ['for open of flags\n  Toggle(bind:open={open})\n', 'snippet row(open: Signal<boolean>)\n  Toggle(bind:open={open})\nrow(flags[0]!)\n', 'const open = flags[0]!\nToggle(bind:open={open})\n']) {
      const dom = compile(child(template), 'dom').tsx

      expect(dom).toContain('.set(kayValue)')
      expect(dom).not.toContain('__props["open"] = kayValue')
    }

    expect(compile(child('Toggle(bind:open={open})\nfor open of flags\n  Toggle(bind:open={open})\n'), 'dom').tsx).toMatch(/__props\["open"\] = kayValue[\s\S]*\.set\(kayValue\)/)
  })

  it('refuses a bind on a member of the rest props, a value, and says to spread them', () => {
    const rest = '---\nimport { type Bindable } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nconst { label, ...rest } = props<{ label: string, open: Bindable<boolean> }>()\n---\nToggle(bind:open={rest.open})\n'

    expect(compile(rest, 'dom').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('is a value')])
  })

  it('types the bind in check mode against the Bindable prop', () => {
    expect(compile(PARENT).tsx).toContain('KayBound(Toggle)("open", (open)(), (kayValue) => (open).set(kayValue))')
  })

  it('refuses a bind that is not an expression or not a name', () => {
    expect(compile('---\nimport Toggle from \'./Toggle.kay\'\n---\nToggle(bind:open="yes")\n', 'dom').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('needs a signal or a `Bindable` prop')])
    expect(compile('---\nimport Toggle from \'./Toggle.kay\'\n---\nToggle(bind:open={1 + 1})\n', 'dom').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('needs a signal or a `Bindable` prop')])
  })
})

describe('the props of a component with a Bindable prop', () => {
  it('writes through a setter the parent bound, and keeps a write local otherwise', () => {
    const open = signal(false)
    const bound = bindable({ get open() {
      return open()
    }, set open(value: boolean) {
      open.set(value)
    } }, ['open'])
    const plain = bindable({ open: false }, ['open'])

    bound.open = true
    expect([open(), bound.open]).toEqual([true, true])
    plain.open = true
    expect(plain.open).toBe(true)
    expect(open()).toBe(true)
  })

  it('follows the parent again once its value changes after a local write', () => {
    const flag = signal(false)
    const parent: { open: boolean } = Object.defineProperty({ open: false }, 'open', { get: () => flag() })
    const props = bindable(parent, ['open'])

    const seen: boolean[] = []

    root(() => renderEffect(() => void seen.push(props.open)))
    props.open = true
    flush()
    flag.set(true)
    flush()
    flag.set(false)
    flush()
    expect(seen).toEqual([false, true, true, false])
  })

  it('does not subscribe an effect that writes the prop', () => {
    const props = bindable({ open: false }, ['open'])
    let runs = 0

    root(() => renderEffect(() => {
      runs++
      props.open = true
    }))
    props.open = false
    flush()
    expect(runs).toBe(1)
  })

  it('drops a stale override when the parent moves away and back before any read', () => {
    const flag = signal(false)
    const parent: { open: boolean } = Object.defineProperty({ open: false }, 'open', { get: () => flag() })
    const props = bindable(parent, ['open'])

    root(() => {
      props.open = true
    })
    flag.set(true)
    flush()
    flag.set(false)
    flush()
    expect(props.open).toBe(false)
  })

  it('hands the prop on as this component holds it through the rest props and a spread', () => {
    const open = signal(false)
    const bound = bindable({ label: 'a', get open() {
      return open()
    }, set open(value: boolean) {
      open.set(value)
    } }, ['open'])
    const plain = bindable({ label: 'a', open: false }, ['open'])

    plain.open = true

    for (const props of [omit(plain, 'label'), merge(plain)]) {
      expect(props.open).toBe(true)
      props.open = false
      expect(plain.open).toBe(false)
      plain.open = true
    }

    expect(omit(bound, 'label').label).toBeUndefined()
    omit(bound, 'label').open = true
    expect(open()).toBe(true)
  })

  it('leaves the other props to the target', () => {
    const props = bindable<{ title: string, open?: boolean }>({ title: 'a' }, ['open'])

    expect(props.title).toBe('a')
    expect(props.open).toBeUndefined()
  })
})
