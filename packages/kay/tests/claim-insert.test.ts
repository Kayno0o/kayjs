import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, test } from 'bun:test'
import { claimInsert } from '../src/dom/claim'
import { hydrate, template } from '../src/dom/index'

// Runs claimInsert inside a hydrate pass over `html` and returns what it reports.
async function claim(html: string, pick: (parent: Element) => { marker: Node | null, start?: Node | null }, render: () => unknown) {
  GlobalRegistrator.register()
  try {
    const host = document.createElement('div')
    host.innerHTML = html
    const parent = host.firstElementChild!
    const { marker, start } = pick(parent)
    let res!: ReturnType<typeof claimInsert>
    hydrate(host, () => {
      res = claimInsert(parent, marker, render, start)
      return null
    })
    return { res, parent }
  }
  finally {
    await GlobalRegistrator.unregister()
  }
}

describe('claimInsert hydration ranges', () => {
  test('a bracketed range returns the nodes between its markers', async () => {
    const { res, parent } = await claim('<p><!----><b>A</b><i>B</i><!--end--></p>', p => ({ marker: p.lastChild, start: p.firstChild }), () => template('<b></b>')())
    expect(res.claimed).toBe(parent.childNodes[1]!)
    expect(res.nodes).toEqual([parent.childNodes[1]!, parent.childNodes[2]!])
    expect(res.marker).toBe(parent.lastChild)
  })

  test('an empty bracketed range claims nothing', async () => {
    const { res } = await claim('<p><!----><!--end--></p>', p => ({ marker: p.lastChild, start: p.firstChild }), () => null)
    expect(res.claimed).toBeNull()
    expect(res.nodes).toBeUndefined()
  })

  test('a trailing insert (no marker) claims from the last child and returns what the render consumed', async () => {
    const { res, parent } = await claim('<p><b>A</b><i>B</i></p>', () => ({ marker: null }), () => template('<i></i>')())
    expect(res.marker).toBeNull()
    expect(res.claimed).toBe(parent.lastChild!)
    expect(res.nodes).toEqual([parent.lastChild!])
  })

  test('a trailing insert that consumes nothing reports no nodes', async () => {
    const { res } = await claim('<p>text</p>', () => ({ marker: null }), () => 'value')
    expect(res.nodes).toBeUndefined()
  })

  test('a marker insert places an anchor after the consumed range', async () => {
    const { res, parent } = await claim('<p><b>A</b><i>B</i><u>C</u></p>', p => ({ marker: p.firstChild }), () => {
      template('<b></b>')()
      return template('<i></i>')()
    })
    expect(res.claimed).toBe(parent.firstChild!)
    expect(res.nodes).toEqual([parent.childNodes[0]!, parent.childNodes[1]!])
    expect(res.marker!.nodeType).toBe(8)
    expect(res.marker!.previousSibling).toBe(parent.childNodes[1]!)
    expect(res.marker!.nextSibling!.nodeName).toBe('U')
  })

  test('a marker insert that moves no cursor claims the one node', async () => {
    const { res, parent } = await claim('<p><b>A</b><u>C</u></p>', p => ({ marker: p.firstChild }), () => 'x')
    expect(res.nodes).toBeUndefined()
    expect(res.marker!.previousSibling).toBe(parent.firstChild!)
  })
})
