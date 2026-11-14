import type { Unit } from '../src/runtime/dom'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { fragment, hydrate, insert, markers, part, Range } from '../src/runtime/dom'
import { root } from '../src/runtime/reactive'

// What a block holding one component compiled to before `part`.
function wrapped(render: () => unknown) {
  return fragment((parent) => {
    const [start, end] = markers(parent)

    insert(null, start, end, render, false)
  })
}

// The markup a unit holds, from its first node to its last.
function markup(unit: Unit | null): string {
  const first = unit instanceof Range ? unit.first : unit
  const last = unit instanceof Range ? unit.last : unit
  const holder = document.createElement('div')

  for (let node: Node | null = first; node; node = node === last ? null : node.nextSibling)
    holder.append(node.cloneNode(true))

  return holder.innerHTML
}

describe('part', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  it('claims the markers of a block holding one component', () => {
    const container = document.createElement('div')

    container.innerHTML = '<!--[--><b>x</b><!--]-->'

    const bold = container.firstElementChild!

    root(() => hydrate(() => part(() => bold), container))

    expect(container.innerHTML).toBe('<!--[--><b>x</b><!--]-->')
    expect(container.firstElementChild).toBe(bold)
  })

  it('builds what the fragment holding the component built, empty rendering included', () => {
    for (const render of [() => document.createElement('i'), () => null, () => 'text']) {
      expect(markup(part(render))).toBe(markup(wrapped(render)))
    }

    expect(markup(part(() => document.createElement('i')))).toBe('<!--[--><i></i><!--]-->')
  })
})
