import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

const PAGE = '<nav>Menu install</nav><main><p>Intro install text</p><h2 id="a">Setup</h2><p>Run <b>install</b> now, ÉTÉ and installing.</p><div><h3 id="deep">Deeper</h3><p>install deeper</p></div><h2 id="b">Next</h2><p>install elsewhere</p></main><script>install()</script>'

let arrival: typeof import('../src/runtime/search-arrival')
let launcher: typeof import('../src/runtime/arrival')
let marked: Range[] = []
let scrolled: Element[] = []

// The words painted, read back off the ranges the page highlighted.
function painted(): string[] {
  return marked.map(range => range.toString())
}

// happy-dom defines some of these as read-only.
function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function mount(html = PAGE): void {
  document.body.innerHTML = html
}

beforeAll(async () => {
  GlobalRegistrator.register()
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this)
  }
  arrival = await import('../src/runtime/search-arrival')
  launcher = await import('../src/runtime/arrival')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  marked = []
  scrolled = []
  class FakeHighlight extends Set<Range> {
    constructor(...ranges: Range[]) {
      super(ranges)
      marked = ranges
    }
  }
  const store = new Map<string, unknown>()

  define('Highlight', FakeHighlight)
  define('CSS', { highlights: { set: (name: string, value: unknown) => store.set(name, value), delete: (name: string) => {
    store.delete(name)
    marked = []
  }, has: (name: string) => store.has(name) } })
  mount()
})

describe('marking a section on arrival', () => {
  it('marks the words of the anchored section only, folded and as prefixes, up to the next heading', () => {
    arrival.markArrival('?kay_q=install+ete', '#a')
    expect(painted()).toEqual(['install', 'ÉTÉ', 'install'])
  })

  it('marks the text above the first heading when the hit has no anchor, never the nav or a script', () => {
    arrival.markArrival('?kay_q=install', '')
    expect(painted()).toEqual(['install'])
    expect(marked[0]!.startContainer.textContent).toBe('Intro install text')
  })

  it('marks a heading found by its own words, and a section holding its subsection under another heading level', () => {
    arrival.markArrival('?kay_q=setup', '#a')
    expect(painted()).toEqual(['Setup'])
    mount()
    arrival.markArrival('?kay_q=deeper', '#deep')
    expect(painted()).toEqual(['Deeper', 'deeper'])
  })

  it('scrolls to the first mark, and marks nothing for an unknown anchor, a missing param or a decoded hash', () => {
    arrival.markArrival('?kay_q=install', '#a')
    expect(scrolled.map(element => element.tagName)).toEqual(['B'])
    arrival.markArrival('?kay_q=install', '#nope')
    expect(painted()).toEqual([])
    arrival.markArrival('', '#a')
    expect(painted()).toEqual([])
    mount('<h2 id="a b">Spaced</h2><p>install here</p>')
    arrival.markArrival('?kay_q=install', '#a%20b')
    expect(painted()).toEqual(['install'])
  })

  it('treats hostile text as words to look for, never as markup', () => {
    mount('<h2 id="a">T</h2><p>img onerror alert</p>')
    arrival.markArrival(`?kay_q=${encodeURIComponent('<img src=x onerror=alert(1)> "\'')}`, '#a')
    expect(painted()).toEqual(['img', 'onerror', 'alert'])
    expect(document.body.querySelectorAll('img').length).toBe(0)
    expect(document.body.innerHTML).not.toContain('<mark')
  })

  it('does nothing, and throws nothing, without the Highlight API', () => {
    define('Highlight', undefined)
    define('CSS', {})
    expect(() => arrival.markArrival('?kay_q=install', '#a')).not.toThrow()
    expect(scrolled).toEqual([])
  })

  it('clears the marks of the page it leaves', () => {
    arrival.markArrival('?kay_q=install', '#a')
    expect(painted().length).toBe(2)
    arrival.markArrival('', '')
    expect(painted()).toEqual([])
  })
})

describe('what asks for the marking', () => {
  it('names the param the index puts in a hit\'s href', () => {
    expect(launcher.ARRIVAL_PARAM).toBe('kay_q')
    expect(launcher.arrives('?a=1&kay_q=x')).toBe(true)
    expect(launcher.arrives('?a=1')).toBe(false)
  })
})
