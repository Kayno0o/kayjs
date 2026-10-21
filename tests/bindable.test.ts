import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { signal } from '../src/runtime/core'
import { bindable } from '../src/runtime/internal'

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

    expect(compile(middle, 'dom').tsx).toContain('{ get "open"() { return (__props.open) }, set "open"(kayValue) { (__props.open) = kayValue } }')
  })

  it('reads and assigns the prop as a plain name, wrapping the props only where a prop is Bindable', () => {
    const dom = compile(CHILD, 'dom').tsx

    expect(dom).toContain('__props = KayBindable(__props, ["open"])')
    expect(dom).toContain('__props.open = !__props.open')
    expect(compile(CHILD, 'html').tsx).toContain('KayBindable')
    expect(compile(CHILD.replace('Bindable<boolean>', 'boolean').replace('import { type Bindable } from \'kay\'\n', ''), 'dom').tsx).not.toContain('KayBindable')
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

  it('leaves the other props to the target', () => {
    const props = bindable<{ title: string, open?: boolean }>({ title: 'a' }, ['open'])

    expect(props.title).toBe('a')
    expect(props.open).toBeUndefined()
  })
})
