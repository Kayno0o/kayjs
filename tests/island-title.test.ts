import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { head, headMark, setsIslandTitle } from '../src/runtime/head'
import { pages } from '../src/server'

const app = new Elysia().use(await pages({ routes: 'tests/fixtures/title/src/routes', prebuilt: false, security: false }))

async function marked(path: string): Promise<string[]> {
  const html = await (await app.handle(new Request(`http://localhost${path}`))).text()

  return [...html.matchAll(/<slot data-component="[^"]*\/([\w-]+)\.kay"([^>]*)>/g)].map(([, name, attributes]) => `${name}${attributes!.includes(' data-titled') ? ' titled' : ''}`)
}

describe('an island setting the page title, rendered by the server', () => {
  it('is marked, each of several islands that do', async () => {
    expect(await marked('/two')).toEqual(['room titled', 'room titled'])
  })

  it('leaves unmarked the island of a client-only render and a static parent of an island that sets one', async () => {
    expect(await marked('/clientside')).toEqual(['room'])
    expect(await marked('/framed')).toEqual(['frame', 'room titled'])
  })

  it('marks the island around a titled one rendered inside it, and no other', async () => {
    expect(await marked('/nested')).toEqual(['room titled', 'outer titled'])
  })

  it('counts a title set outside a page render, as a server island or a streamed block renders', () => {
    const mark = headMark()

    head([{ tag: 'meta', props: { name: 'description', content: 'x' } }])
    expect(setsIslandTitle(mark)).toBe(false)

    head([{ tag: 'title', props: { island: true } }])
    expect(setsIslandTitle(mark)).toBe(true)
  })
})
