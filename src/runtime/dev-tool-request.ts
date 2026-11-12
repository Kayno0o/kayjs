import type { DevRequest, DevResponse } from '../server/dev'
import type { DevTool } from './dev-tool'
import { FIRST_HEADERS, HEAD_HEADER, PRERENDER, REQUEST, REQUEST_URL } from './dev-tool-constants'
import { copyButton, filterable, formatMs, ownFetch, pill, positionButton, toolbar } from './dev-tool-parts'

// The dev tool's Request tab: what served the page. Split from dev-tool.ts, which the dev server serves with the modules it imports.

// An entry of the `Server-Timing` header kay sends, one of its phases rather than a single load.
const SERVER_PHASE = /(?:^|,)\s*(guards|import|loads|render)(?:;[^,;]*)*?;dur=(\d+(?:\.\d+)?)/g

// A guard that did not run is no failure, so it has no tone.
function guardTone(outcome: string): 'ok' | 'error' | undefined {
  if (outcome === 'did not run')
    return undefined

  return outcome === 'passed' ? 'ok' : 'error'
}

// What served the page: the route it matched, the files that rendered it, outermost first, its params and status, and how long each load took on the scale of the whole request; read again after each page swap.
export function requestTab(doc: Document, tool: DevTool): { stop: () => void } {
  const tab = tool.tab({ id: 'request', label: 'Request', icon: 'server' })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter facts and headers', () => bar.apply(content))
  // The block the tab shows now.
  let current: string | undefined
  const section = (heading: string, ...children: Node[]) => {
    const element = tool.make('section', 'group')

    element.append(tool.make('h3', 'heading', heading), ...children)

    return element
  }
  // What the server recorded of the response: asked for once the page is in view, and dropped if another page's block replaced this one while it was out.
  const showResponse = async (id: string, block: string, line: HTMLElement, facts: HTMLElement, timing: (total: number, phases: ServerPhases) => void, panel: HTMLElement) => {
    let recorded: DevResponse | undefined

    try {
      const response = await ownFetch(doc.defaultView!, `${REQUEST_URL}?id=${encodeURIComponent(id)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store' })

      recorded = response.ok ? await response.json() as DevResponse : undefined
    }
    catch {
      recorded = undefined
    }

    if (current !== block)
      return

    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }

    if (recorded === undefined) {
      fact('Response', tool.make('span', 'note', 'not recorded by the server'))
      bar.apply(panel)

      return
    }

    const hops = recorded.redirects.map(hop => tool.make('span', 'mono', `${hop.from} (${hop.status}${hop.by === undefined ? '' : `, by ${hop.by}`})`))
    const rank = (name: string) => !FIRST_HEADERS.includes(name) ? FIRST_HEADERS.length : FIRST_HEADERS.indexOf(name)
    const headers = [...recorded.headers].sort(([a], [b]) => rank(a) - rank(b))
    const table = tool.make('table', 'headers')

    line.append(pill(tool, `${formatMs(recorded.ms)} on the server`))
    fact('Redirected', ...hops.length === 0 ? [tool.make('span', 'note', 'no')] : hops)
    timing(recorded.ms, serverPhases(recorded.headers.find(([name]) => name === 'server-timing')?.[1] ?? ''))

    for (const [name, value] of headers)
      table.append(filterable(headerRow(tool, name, value), `${name}: ${value}`))

    panel.insertBefore(section('Response headers', headers.length === 0 ? tool.make('span', 'note', 'none') : table), bar.empty)
    bar.apply(panel)
  }
  const read = () => {
    // A swap adds the next page's block before it drops this one's.
    const block = [...doc.querySelectorAll(`script#${REQUEST}`)].at(-1)?.textContent

    current = block ?? undefined

    bar.element.hidden = block === undefined || block === null

    if (block === undefined || block === null) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', 'kay served no request block with this page.'))

      return
    }

    const request = JSON.parse(block) as DevRequest
    const win = doc.defaultView!
    const line = tool.make('div', 'reqline')
    const facts = tool.make('dl', 'facts')
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }
    const params = Object.entries(request.params)
    const chips = tool.make('span', 'chips')
    const chain = tool.make('ul', 'chain')
    const step = (kind: string, file: HTMLElement, depth: number, outcome?: HTMLElement) => {
      const item = tool.make('li')
      const where = tool.make('span', 'd')

      where.style.setProperty('--depth', String(depth))
      where.append(file)
      item.append(tool.make('span', 'k', kind), where, outcome ?? tool.make('span'))
      chain.append(filterable(item, `${kind} ${file.textContent} ${outcome?.textContent ?? ''}`))
    }
    const timing = tool.make('section', 'group')
    const { slow } = request
    const slowNote = slow === undefined ? undefined : `The loads took ${formatMs(slow.took)}, over the ${formatMs(slow.budget)} of observe.loadBudget; the slowest is ${slow.file} at ${formatMs(slow.ms)}. The page waits for every load before it sends anything: start what the first paint does not need unawaited and read it in an await block, or cache it.`
    const scaled = (total?: number, phases: ServerPhases = {}) => {
      const longest = Math.max(total ?? 0, ...Object.values(phases), ...request.loads.map(load => load.ms ?? 0))
      const grid = tool.make('div', 'timing')
      const bar = (ms: number | undefined, className = 'bars') => {
        const track = tool.make('span', className)
        const fill = tool.make('i')

        fill.style.width = ms === undefined || longest === 0 ? '0' : `${Math.max(1, ms / longest * 100)}%`
        track.append(fill)

        return track
      }

      const phase = (name: keyof ServerPhases, label: string) => {
        const ms = phases[name]

        if (ms !== undefined)
          grid.append(tool.make('span', 'note', label), bar(ms), tool.make('span', 'v', formatMs(ms)))
      }

      phase('guards', 'Guards')
      phase('import', 'Importing modules')
      phase('loads', request.loads.length > 1 ? 'Loads, run at once' : 'Loads')

      for (const load of request.loads)
        grid.append(positionButton(tool, load.file), bar(load.ms), tool.make('span', 'v', load.ms === undefined ? 'not timed' : formatMs(load.ms)))

      phase('render', 'Render, what a stream sends first')

      if (total !== undefined)
        grid.append(tool.make('span', 'note', 'Whole request'), bar(total, 'bars total'), tool.make('span', 'v', formatMs(total)))

      timing.hidden = request.loads.length === 0 && total === undefined
      timing.replaceChildren(tool.make('h3', 'heading', 'Time on the server'), grid, ...slowNote === undefined ? [] : [tool.make('p', 'note', slowNote)])
    }
    // Read off the page once the guards pass, so a request one refused says nothing of it.
    const refusedByGuard = request.guards.some(guard => guard.outcome !== 'passed' && guard.outcome !== 'did not run')
    const rendered = request.prerender === undefined ? 'on request' : `on request here, ${PRERENDER[request.prerender]}`
    const status = pill(tool, request.error === undefined ? String(request.status) : `${request.status} ${request.error}`, request.status >= 400 ? 'error' : 'ok')
    const path = tool.make('span', 'path', `${win.location.pathname}${win.location.search}`)

    line.append(tool.make('span', 'method', 'GET'), path, status)
    tab.count(request.status >= 400 || slow !== undefined ? 1 : 0, request.status >= 400 ? 'error' : 'warn')

    if (slowNote !== undefined)
      console.warn(`kay: ${slowNote}`)

    fact('Route', request.route === undefined ? tool.make('span', 'note', 'none matched') : tool.make('span', 'mono', request.route))
    chips.append(...params.map(([name, value]) => tool.make('span', 'chip', `${name} = ${JSON.stringify(value)}`)))
    fact('Params', params.length === 0 ? tool.make('span', 'note', 'none') : chips)

    fact('Locale', request.locale)
    fact('Rendered', refusedByGuard ? 'not known, a guard refused the request' : rendered)

    for (const guard of request.guards)
      step('Guard', positionButton(tool, guard.file), 0, pill(tool, guard.outcome, guardTone(guard.outcome)))

    for (const [depth, layout] of request.layouts.entries())
      step('Layout', positionButton(tool, layout), depth)

    step('Page', positionButton(tool, request.page), request.layouts.length)
    scaled()
    content.replaceChildren(line, section('Matched', facts), section('Files, outermost first', chain), timing, bar.empty)
    bar.apply(content)
    void showResponse(request.id, block, line, facts, scaled, content)
  }
  // A page swap, or the patch a page without one gets, brings the next page's block.
  const swaps = new MutationObserver((records) => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (node as Element).id === REQUEST)))
      read()
  })

  tab.panel.append(bar.element, content)
  read()
  swaps.observe(doc.head, { childList: true })

  return { stop: () => swaps.disconnect() }
}

// The phases of a page's render its `Server-Timing` header gives, in milliseconds.
type ServerPhases = Partial<Record<'guards' | 'import' | 'loads' | 'render', number>>

function serverPhases(header: string): ServerPhases {
  const phases: ServerPhases = {}

  for (const [, name, ms] of header.matchAll(SERVER_PHASE))
    phases[name as keyof ServerPhases] = Number(ms)

  return phases
}

// A header as a row of two cells, except a policy: its directives each get a line, as one wrapped block of hashes hides which is which.
function headerRow(tool: DevTool, name: string, value: string): HTMLElement {
  const row = tool.make('tr')
  const cell = tool.make('td')
  const directives = name.startsWith('content-security-policy') ? value.split(';').map(directive => directive.trim()).filter(directive => directive !== '') : []

  if (directives.length < 2)
    cell.textContent = value
  else
    cell.append(...directives.map(directive => tool.make('span', 'directive', `${directive};`)))

  cell.append(copyButton(tool, `the ${name} header`, value))
  row.append(tool.make('td', '', name), cell)

  return row
}
