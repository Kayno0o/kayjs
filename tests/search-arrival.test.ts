import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

const PAGE = '<nav>Menu install</nav><main><p>Intro install text</p><h2 id="a">Setup</h2><p>Run <b>install</b> now, ÉTÉ and installing.</p><div><h3 id="deep">Deeper</h3><p>install deeper</p></div><h2 id="b">Next</h2><p>install elsewhere</p></main><script>install()</script>'

let arrival: typeof import('../src/runtime/search-arrival')
let launcher: typeof import('../src/runtime/arrival')
let marked: Range[] = []
let scrolled: Element[] = []
// Where the first mark sits on screen, as the layout would say.
let top = 100

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
  GlobalRegistrator.register({ url: 'http://localhost/' })
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this)
  }
  Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20 }) as DOMRect
  arrival = await import('../src/runtime/search-arrival')
  launcher = await import('../src/runtime/arrival')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  marked = []
  scrolled = []
  top = 100
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

  it('marks nothing for an unknown anchor, a missing param or a decoded hash that is none, and finds an encoded id', () => {
    arrival.markArrival('?kay_q=install', '#nope')
    expect(painted()).toEqual([])
    arrival.markArrival('', '#a')
    expect(painted()).toEqual([])
    mount('<h2 id="a b">Spaced</h2><p>install here</p>')
    arrival.markArrival('?kay_q=install', '#a%20b')
    expect(painted()).toEqual(['install'])
  })

  it('scrolls to the first mark centred, only when it is out of view and the window has not moved since', () => {
    arrival.markArrival('?kay_q=install', '#a')
    expect(scrolled).toEqual([])
    top = -50
    arrival.markArrival('?kay_q=install', '#a')
    expect(scrolled.map(element => element.tagName)).toEqual(['B'])
    scrolled = []
    arrival.markArrival('?kay_q=install', '#a', scrollY + 40)
    expect(scrolled).toEqual([])
    expect(painted().length).toBe(2)
  })

  it('finds the section of a layout that wraps the content, and of a heading wrapped itself', () => {
    mount('<main id="content"><div class="page"><article><p>Intro install</p><div><h2 id="a">Setup</h2></div><section><p>install one</p></section><p>install two</p><div><h3 id="n">Next</h3><p>install out</p></div></article></div></main><p>install after</p>')
    arrival.markArrival('?kay_q=install', '#a')
    expect(painted()).toEqual(['install', 'install'])
    arrival.markArrival('?kay_q=install', '')
    expect(painted()).toEqual(['install'])
    expect(marked[0]!.startContainer.textContent).toBe('Intro install')
    arrival.markArrival('?kay_q=install', '#n')
    expect(painted()).toEqual(['install', 'install'])
  })

  it('reads at most eight words of a link, each cut at 64 characters, and none of one letter', () => {
    mount(`<h2 id="a">${'a'.repeat(70)} one two three four five six seven eight nine x</h2>`)
    arrival.markArrival(`?kay_q=${'a'.repeat(70)}+x+one+two+three+four+five+six+seven+eight+nine`, '#a')
    expect(painted()).toEqual(['a'.repeat(64), 'one', 'two', 'three', 'four', 'five', 'six', 'seven'])
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

  it('loads the marking only for a query asking for it or marks to clear, and clears them otherwise', async () => {
    const at = async (search: string) => {
      history.replaceState(null, '', `/${search}#a`)
      await launcher.arrive(search, 0)
    }

    mount()
    await at('?a=1')
    expect(painted()).toEqual([])

    await at('?kay_q=install')
    expect(painted()).toEqual(['install', 'install'])

    await at('?a=1')
    expect(painted()).toEqual([])
  })

  it('marks nothing for a page swapped away from while the marking loaded', async () => {
    mount()
    history.replaceState(null, '', '/?kay_q=install#a')
    const pending = launcher.arrive('?kay_q=install', 0)

    history.replaceState(null, '', '/?a=1#a')
    await pending
    expect(painted()).toEqual([])
  })
})
