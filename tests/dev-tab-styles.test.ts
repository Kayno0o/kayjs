import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import stylesTab from '../src/runtime/dev-tab-styles'
import { startDevTool } from '../src/runtime/dev-tool'

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const view = { name: 'Panel', key: 'Panel', recipe: true, exists: true, parts: [{ name: 'root', classes: 'p-2' }, { name: 'body', classes: 'text-sm', set: 'p-9' }], variants: { size: ['sm', 'lg'] }, tokens: [{ name: '--kui-border-width', value: '1px' }] }

describe('the Styles tab', () => {
  let tool: DevTool | undefined

  afterEach(() => {
    tool?.stop()
    tool = undefined
    document.body.replaceChildren()
  })

  const open = (answer: (url: string, init?: RequestInit) => Response) => {
    const calls: [string, string | undefined][] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (url.startsWith('/_kay/dev/ui'))
        calls.push([`${init?.method ?? 'GET'} ${url}`, init?.body as string | undefined])

      return answer(url, init)
    }) as unknown as typeof window.fetch)

    tool = startDevTool()

    const tab = tool.tab({ id: 'styles-under-test', label: 'Styles' })

    stylesTab(tool, tab)
    tab.panel.hidden = false

    return { panel: tab.panel, calls, done: () => fetching.mockRestore() }
  }

  const hover = async (target: Element) => {
    target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }))
    await Bun.sleep(0)
    await Bun.sleep(0)
  }

  const page = () => {
    document.body.innerHTML = '<main data-kay-src="src/routes/index.kay:1:1"><div id="panel" data-kay-src="src/components/panel.kay:5:1"><div id="body" data-part="body" data-kay-src="src/components/panel.kay:6:3"><p id="text" data-kay-src="src/routes/index.kay:3:5">hi</p></div></div></main>'
  }

  it('shows the parts, variants and tokens of the nearest component with parts under the pointer', async () => {
    page()

    const { panel, calls, done } = open(url => url.includes('panel.kay') ? Response.json(view) : new Response(null, { status: 404 }))

    await hover(document.getElementById('text')!)
    expect(calls.map(call => call[0])).toEqual(['GET /_kay/dev/ui?file=src%2Froutes%2Findex.kay', 'GET /_kay/dev/ui?file=src%2Fcomponents%2Fpanel.kay'])
    expect(panel.querySelector('.heading')!.textContent).toBe('Panel')
    expect([...panel.querySelectorAll('.row .pill')].map(pill => pill.textContent)).toEqual(['root', 'body'])
    expect(panel.querySelectorAll<HTMLTextAreaElement>('.row textarea')[1]!.value).toBe('p-9')
    expect(panel.textContent).toContain('size:')
    expect(panel.textContent).toContain('--kui-border-width: 1px')
    done()
  })

  it('writes a part\'s classes to src/ui.ts and says so, or says why it could not', async () => {
    page()

    let fail = false
    const { panel, calls, done } = open((_url, init) => {
      if (init?.method !== 'POST')
        return Response.json(view)

      return fail ? Response.json({ error: 'src/ui.ts has no default export' }, { status: 422 }) : Response.json({ key: 'Panel', created: false })
    })

    await hover(document.getElementById('panel')!)

    const write = panel.querySelector<HTMLButtonElement>('.row button')!

    panel.querySelector<HTMLTextAreaElement>('.row textarea')!.value = 'p-4'
    write.click()
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(calls.at(-1)).toEqual(['POST /_kay/dev/ui', JSON.stringify({ file: 'src/components/panel.kay', part: 'root', classes: 'p-4' })])
    expect(panel.querySelector('.note')!.textContent).toBe('Wrote root of Panel to src/ui.ts.')

    fail = true
    write.click()
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(panel.querySelector('.note')!.textContent).toBe('Could not write src/ui.ts: src/ui.ts has no default export')
    done()
  })

  it('does nothing while its tab is hidden, and for a pointer over the tool itself', async () => {
    page()

    const { panel, calls, done } = open(() => Response.json(view))

    panel.hidden = true
    await hover(document.getElementById('panel')!)
    panel.hidden = false
    await hover(tool!.root.host)
    expect(calls).toEqual([])
    done()
  })
})
