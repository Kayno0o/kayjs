import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { classText } from '../src/runtime/values'

let dom: typeof import('../src/runtime/dom')
let reactive: typeof import('../src/runtime/reactive')
let actionStub: typeof import('../src/runtime/action').actionStub

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })

  dom = await import('../src/runtime/dom')
  reactive = await import('../src/runtime/reactive')
  ;({ actionStub } = await import('../src/runtime/action'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++)
    await Bun.sleep(0)
}

describe('classText', () => {
  it('keeps the first of a repeated class and the order the classes came in', () => {
    expect(classText(['a', 'b', 'a'])).toBe('a b')
    expect(classText(['a b', 'c', 'a b'])).toBe('a b c')
    expect(classText(['', 'a', undefined, 'b'])).toBe('a b')
  })

  it('puts a class that reads as an array index first, as an object holds its keys', () => {
    expect(classText(['a', '10', 'b', '2'])).toBe('2 10 a b')
    expect(classText(['a', 7, 'b'])).toBe('7 a b')
    expect(classText(['1x', 'a'])).toBe('1x a')
  })

  it('reads an object after a string, its false value turning off a class already named', () => {
    expect(classText(['a', { a: false, b: true }])).toBe('b')
    expect(classText(['a', { b: true }, 'c'])).toBe('a b c')
    expect(classText(['a', ['b', ['a', 'c']], 0, false, null])).toBe('0 a b c')
  })

  it('drops the literal `undefined` and an empty name', () => {
    expect(classText(['undefined', 'a'])).toBe('a')
  })
})

describe('attribute', () => {
  it('writes a name no URL can be in as it is, a value starting like a script included', () => {
    const element = document.createElement('div')

    dom.attribute(element, 'data-href', 'javascript:alert(1)')
    dom.attribute(element, 'title', '/about')
    dom.attribute(element, 'aria-pressed', false)
    dom.attribute(element, 'hidden', true)
    expect(element.getAttribute('data-href')).toBe('javascript:alert(1)')
    expect(element.getAttribute('title')).toBe('/about')
    expect(element.getAttribute('aria-pressed')).toBe('false')
    expect(element.getAttribute('hidden')).toBe('')
  })

  it('marks a script URL unsafe whatever the name\'s case, and a `data` object too', () => {
    const link = document.createElement('a')

    for (const name of ['href', 'HREF', 'Src', 'formaction', 'xlink:href', 'poster', 'data'])
      dom.attribute(link, name, ' java\tscript:alert(1)')

    expect([...link.attributes].map(({ value }) => value)).toEqual(Array.from({ length: link.attributes.length }, () => ' java\tscript:alert(1)'.replace(/^/, 'unsafe:')))
    expect(link.attributes.length).toBeGreaterThan(0)
  })

  it('removes an attribute set to null or false', () => {
    const element = document.createElement('div')

    element.setAttribute('title', 'x')
    dom.attribute(element, 'title', null)
    expect(element.hasAttribute('title')).toBe(false)
  })
})

describe('listen', () => {
  it('runs a handler of a delegated event from the document and of another on the element', () => {
    const button = document.createElement('button')
    const seen: string[] = []

    document.body.append(button)
    dom.listen(button, 'onClick', () => seen.push('click'))
    dom.listen(button, 'onDblClick', () => seen.push('dblclick'))
    dom.listen(button, 'onMyEvent', () => seen.push('myevent'))
    dom.listen(button, 'onFocus', () => seen.push('focus'))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    button.dispatchEvent(new Event('myevent'))
    button.dispatchEvent(new Event('focus'))
    expect(seen).toEqual(['click', 'dblclick', 'myevent', 'focus'])

    dom.unlisten(button, 'onClick')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(seen).toHaveLength(4)
    button.remove()
  })

  it('reports the element the handler sits on as currentTarget while it bubbles from a child', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('span')
    let target: EventTarget | null = null

    outer.append(inner)
    document.body.append(outer)
    dom.listen(outer, 'onMouseDown', (event) => {
      target = event.currentTarget
    })
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(target === outer).toBe(true)
    outer.remove()
  })
})

describe('branches', () => {
  async function mount(list: Parameters<typeof dom.branches>[3]) {
    const parent = document.createElement('div')

    document.body.append(parent)
    dom.branches(parent, null, null, list)

    return parent
  }

  it('builds a branch again only when another takes over, with or without a name for the value', async () => {
    const [count, setCount] = reactive.createSignal(1)
    let named = 0
    let free = 0
    const withAlias = await mount([[count, (value) => {
      named++

      return Object.assign(document.createElement('p'), { textContent: `n${String(value())}` })
    }], [null, () => document.createElement('i')]])
    const without = await mount([[count, () => {
      free++

      return document.createElement('p')
    }], [null, () => document.createElement('i')]])

    expect([withAlias.innerHTML, without.innerHTML]).toEqual(['<p>n1</p>', '<p></p>'])
    setCount(2)
    await settle()
    expect([withAlias.innerHTML, without.innerHTML, named, free]).toEqual(['<p>n1</p>', '<p></p>', 1, 1])
    setCount(0)
    await settle()
    expect([withAlias.innerHTML, without.innerHTML]).toEqual(['<i></i>', '<i></i>'])
    setCount(3)
    await settle()
    expect([withAlias.innerHTML, without.innerHTML, named, free]).toEqual(['<p>n3</p>', '<p></p>', 2, 2])
  })

  it('reads a test only as far as the first branch that passes, and an else last', async () => {
    const [first, setFirst] = reactive.createSignal(false)
    const [second, setSecond] = reactive.createSignal(false)
    let reads = 0
    const parent = await mount([[first, () => document.createElement('a')], [() => {
      reads++

      return second()
    }, () => document.createElement('b')], [null, () => document.createElement('i')]])

    expect([parent.innerHTML, reads]).toEqual(['<i></i>', 1])
    setSecond(true)
    await settle()
    expect(parent.innerHTML).toBe('<b></b>')
    setFirst(true)
    await settle()
    expect(parent.innerHTML).toBe('<a></a>')
    setFirst(false)
    setSecond(false)
    await settle()
    expect(parent.innerHTML).toBe('<i></i>')
  })

  it('hands a branch naming its value the first truthy value, which follows the test while the branch stays', async () => {
    const [count, setCount] = reactive.createSignal(1)
    const seen: unknown[] = []
    const parent = await mount([[count, (value) => {
      const text = document.createTextNode('')

      reactive.renderEffect(() => {
        seen.push(value())
        text.data = String(value())
      })

      return text
    }]])

    expect(parent.textContent).toBe('1')
    setCount(2)
    await settle()
    expect([parent.textContent, seen]).toEqual(['2', [1, 2]])
  })
})

describe('choose', () => {
  it('builds a branch again only when another takes over, as a chain naming no value does', async () => {
    const [count, setCount] = reactive.createSignal(1)
    const [other, setOther] = reactive.createSignal(false)
    const parent = document.createElement('div')
    let built = 0

    document.body.append(parent)
    dom.choose(parent, null, null, [[count, () => {
      built++

      return document.createElement('p')
    }], [other, () => document.createElement('b')], [null, () => document.createElement('i')]])
    expect([parent.innerHTML, built]).toEqual(['<p></p>', 1])
    setCount(5)
    await settle()
    expect([parent.innerHTML, built]).toEqual(['<p></p>', 1])
    setCount(0)
    await settle()
    expect(parent.innerHTML).toBe('<i></i>')
    setOther(true)
    await settle()
    expect(parent.innerHTML).toBe('<b></b>')
    setCount(2)
    await settle()
    expect([parent.innerHTML, built]).toEqual(['<p></p>', 2])
  })
})

describe('an action stub', () => {
  it('reads pending, succeeded and failed from the first read on, whenever that is', async () => {
    const answered = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      await Bun.sleep(5)

      return new Response(stringify('ok'))
    }) as unknown as typeof fetch)

    try {
      const late = actionStub('/_kay/action/test/late') as unknown as { (input: object): Promise<unknown>, pending: () => boolean, succeeded: () => { data: unknown } | undefined }
      const early = actionStub('/_kay/action/test/early') as unknown as typeof late
      const seen: boolean[] = []
      const stop = reactive.root((dispose) => {
        reactive.renderEffect(() => void seen.push(early.pending()))

        return dispose
      })

      const running = [late({}), early({})]

      expect([late.pending(), early.pending()]).toEqual([true, true])
      await Promise.all(running)
      await settle()
      expect([late.pending(), early.pending(), seen]).toEqual([false, false, [false, true, false]])
      expect(late.succeeded()?.data).toBe('ok')
      stop()

      const idle = actionStub('/_kay/action/test/idle') as unknown as typeof late

      expect([idle.pending(), idle.succeeded()]).toEqual([false, undefined])
    }
    finally {
      answered.mockRestore()
    }
  })
})
