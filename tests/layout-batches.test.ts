import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { settle } from '../src/test'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// happy-dom runs a frame as an immediate, so two of these asked after the runtime's frames run after them.
const twoFrames = async () => new Promise(resolve => setImmediate(() => setImmediate(resolve)))
const updated = async () => new Promise<void>(resolve => queueMicrotask(resolve))

async function finished() {
  await twoFrames()
  await new Promise(resolve => setTimeout(resolve, 210))
}

// A `for` between two markers of a parent, each row a `p` with a fade transition of 200 ms, or a plain one.
async function mountList(animated: boolean, initial: number[] = []) {
  const { loop, markers, transition } = await import('../src/runtime/dom')
  const { createSignal, root } = await import('../src/runtime/reactive')
  const parent = document.createElement('div')
  const [items, setItems] = createSignal(initial)

  document.body.append(parent)

  const dispose = root((stop) => {
    const [start, end] = markers(parent)

    loop(null, start, end, items, item => item, (item) => {
      const row = document.createElement('p')

      row.textContent = String(item())

      if (animated) {
        row.setAttribute('style', 'transition-duration: 200ms')
        transition(row, 'name', 'fade')
      }

      return row
    })

    return stop
  })

  await settle()

  return { parent, setItems, dispose: () => {
    dispose()
    parent.remove()
  } }
}

const range = (count: number) => Array.from({ length: count }, (_, index) => index)

describe('transitions of a list', () => {
  it('play every row of a list that enters together, then leave only the rows', async () => {
    const { parent, setItems, dispose } = await mountList(true)

    try {
      setItems(range(20))
      await settle()

      const rows = [...parent.querySelectorAll('p')]

      expect(rows).toHaveLength(20)
      expect(new Set(rows.map(row => row.className))).toEqual(new Set(['fade-enter-from fade-enter-active']))
      await twoFrames()
      expect(new Set(rows.map(row => row.className))).toEqual(new Set(['fade-enter-active fade-enter-to']))
      await finished()
      expect(new Set(rows.map(row => row.className))).toEqual(new Set(['']))

      setItems([])
      await updated()
      expect(rows.every(row => row.isConnected)).toBe(true)
      expect(new Set(rows.map(row => row.className))).toEqual(new Set(['fade-leave-from fade-leave-active']))
      await finished()
      expect(rows.some(row => row.isConnected)).toBe(false)
      expect(parent.childNodes).toHaveLength(2)
    }
    finally {
      dispose()
    }
  })

  it('leave a row at once, no class written, under reduced motion, as it is asked at each change', async () => {
    const original = globalThis.matchMedia
    let reduced = true

    globalThis.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce') })) as typeof matchMedia

    const { parent, setItems, dispose } = await mountList(true, range(3))

    try {
      const rows = [...parent.querySelectorAll('p')]

      expect(rows.map(row => row.className)).toEqual(['', '', ''])
      setItems([])
      await settle()
      expect(rows.some(row => row.isConnected)).toBe(false)

      reduced = false
      setItems(range(2))
      await updated()
      expect(parent.querySelector('p')!.className).toBe('fade-enter-from fade-enter-active')
      await finished()
      reduced = true
      setItems([])
      await settle()
      expect(parent.querySelector('p')).toBeNull()
    }
    finally {
      globalThis.matchMedia = original
      dispose()
    }
  })
})

describe('clearing a list between markers', () => {
  it('removes every row and keeps the markers and what follows them', async () => {
    const { parent, setItems, dispose } = await mountList(false, range(300))

    try {
      const after = document.createElement('i')

      parent.append(after)
      expect(parent.querySelectorAll('p')).toHaveLength(300)
      setItems([])
      await settle()
      expect([...parent.childNodes].map(node => node.nodeName)).toEqual(['#comment', '#comment', 'I'])
      setItems(range(2))
      await settle()
      expect([...parent.childNodes].map(node => node.nodeName)).toEqual(['#comment', 'P', 'P', '#comment', 'I'])
    }
    finally {
      dispose()
    }
  })

  it('leaves a row that plays a leave phase where it is until the phase ends', async () => {
    const { parent, setItems, dispose } = await mountList(true, range(4))

    try {
      await finished()
      setItems([])
      await settle()
      expect(parent.querySelectorAll('p')).toHaveLength(4)
      await finished()
      expect(parent.querySelectorAll('p')).toHaveLength(0)
    }
    finally {
      dispose()
    }
  })
})

describe('the title an island sets', () => {
  it('wraps in the template the page serves, the fallback standing for an empty one, as the settings change', async () => {
    const { pageTitle } = await import('../src/runtime/page-title')
    const { createSignal, root } = await import('../src/runtime/reactive')
    const meta = document.createElement('meta')
    const [text, setText] = createSignal('Room')

    meta.name = 'kay-title'
    meta.content = JSON.stringify({ template: '%s | Site', fallback: 'Site' })
    document.head.append(meta)

    const dispose = root((stop) => {
      pageTitle(text, false)

      return stop
    })

    try {
      expect(document.title).toBe('Room | Site')
      setText('Lobby')
      await settle()
      expect(document.title).toBe('Lobby | Site')
      setText(' ')
      await settle()
      expect(document.title).toBe('Site')
      meta.content = JSON.stringify({ template: '%s - Other' })
      setText('Hall')
      await settle()
      expect(document.title).toBe('Hall - Other')
      meta.remove()
      setText('Bare')
      await settle()
      expect(document.title).toBe('Bare')
    }
    finally {
      dispose()
      meta.remove()
    }
  })
})
