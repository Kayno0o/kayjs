import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

type Props = Record<string, unknown>

let spread: typeof import('../src/runtime/dom-spread').spread
let reactive: typeof import('../src/runtime/reactive')

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ spread } = await import('../src/runtime/dom-spread'))
  reactive = await import('../src/runtime/reactive')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// Spreads a prop object that changes, returning the element and how to change it.
function spreading(tag: string, first: Props) {
  const { createSignal, root, flush } = reactive
  const [props, setProps] = createSignal<Props>(first)
  const element = document.createElement(tag)

  document.body.append(element)
  root(() => spread(element, () => [props()]))

  return { element, change: (next: Props) => {
    setProps(next)
    flush()
  } }
}

describe('a spread class that goes and comes back', () => {
  it('puts the same class back after a prop object without one', () => {
    const { element, change } = spreading('div', { class: 'a b' })

    expect(element.getAttribute('class')).toBe('a b')
    change({})
    expect(element.getAttribute('class')).toBeNull()
    change({ class: 'a b' })
    expect(element.getAttribute('class')).toBe('a b')
  })

  it('puts it back after an empty or undefined one too, and drops it again', () => {
    const { element, change } = spreading('div', { class: 'a' })

    change({ class: undefined })
    expect(element.getAttribute('class')).toBeNull()
    change({ class: 'a' })
    expect(element.getAttribute('class')).toBe('a')
    change({ class: '' })
    expect(element.getAttribute('class')).toBeNull()
    change({ class: 'a' })
    expect(element.getAttribute('class')).toBe('a')
    change({})
    change({})
    change({ class: 'a' })
    expect(element.getAttribute('class')).toBe('a')
  })
})

describe('a spread handler that is withdrawn', () => {
  it('stops firing once it is undefined, dropped, or no longer a function', () => {
    let clicks = 0
    const handler = () => {
      clicks++
    }
    const { element, change } = spreading('button', { onClick: handler })

    element.click()
    expect(clicks).toBe(1)
    change({ onClick: undefined })
    element.click()
    expect(clicks).toBe(1)
    change({ onClick: handler })
    element.click()
    expect(clicks).toBe(2)
    change({})
    element.click()
    expect(clicks).toBe(2)
    change({ onClick: handler })
    element.click()
    expect(clicks).toBe(3)
    change({ onClick: 'alert(1)' })
    element.click()
    expect(clicks).toBe(3)
    change({ onClick: handler })
    element.click()
    expect(clicks).toBe(4)
  })

  it('swaps to a new handler without the old one running', () => {
    const calls: string[] = []
    const { element, change } = spreading('button', { onClick: () => calls.push('a') })

    change({ onClick: () => calls.push('b') })
    element.click()
    expect(calls).toEqual(['b'])
  })
})
