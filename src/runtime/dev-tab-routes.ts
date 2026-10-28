import type { DevRoute, DevRoutes } from '../server/dev'
import type { DevTab, DevTool } from './dev-tool'

// The Routes tab's code, fetched the first time the tab opens, with the tool's shared helpers from `tool.kit`.
const ROUTES_URL = '/_kay/dev/routes'
const BUILT_EVENT = 'kay-dev-built'
const ROUTE_KINDS: Record<Exclude<DevRoute['kind'], 'plumbing'>, string> = { page: 'Pages', endpoint: 'Endpoints', api: 'API', kay: 'Served by kay' }
const DOCS_ORIGIN = 'https://kayjs.kaynooo.fr'

// Every route the server serves, filtered as typed, each opening its file, the GET paths no request fills in linking to themselves; fetched as the tab shows and again after each restart, so it lists what the running server serves. What kay serves itself holds the pages one visits, then kay's plumbing under a heading of its own.
export default function routesTab(tool: DevTool, tab: DevTab): () => void {
  const { filterable, ownFetch, pill, toolbar } = tool.kit
  const win = tool.root.ownerDocument.defaultView!
  const body = tool.make('div', 'list')
  let routes: DevRoute[] = []
  let notes: string[] = []
  // A restart while a fetch is out asks again; the latest answer wins.
  let asked = 0
  let render: () => void = () => undefined
  const bar = toolbar('Filter by path, file or purpose', () => render())

  render = () => {
    const group = (label: string, rows: DevRoute[], tag: 'h3' | 'h4', before: HTMLElement[] = []) => {
      const section = tool.make('section', 'group')
      const heading = tool.make(tag, 'heading', label)
      const list = tool.make('div')

      list.append(...rows.map(route => filterable(routeRow(tool, route, win.location), `${route.path} ${route.file} ${route.owner ?? ''}`)))
      heading.append(pill(String(rows.length + before.reduce((count, element) => count + element.querySelectorAll('[data-filter]').length, 0))))
      section.append(heading, ...rows.length > 0 ? [list] : [], ...before)

      return section
    }
    const sections = Object.entries(ROUTE_KINDS).flatMap(([kind, label]) => {
      const ofKind = routes.filter(route => route.kind === kind)
      const plumbing = kind === 'kay' ? routes.filter(route => route.kind === 'plumbing') : []

      if (ofKind.length === 0 && plumbing.length === 0)
        return []

      return [group(label, ofKind, 'h3', plumbing.length === 0 ? [] : [group('kay\'s plumbing', plumbing, 'h4')])]
    })

    body.replaceChildren(...sections.length > 0 ? sections : [tool.make('div', 'empty', 'No routes.')], bar.empty, ...notes.map(note => tool.make('div', 'note', note)))
    bar.apply(body)
  }
  const list = async () => {
    const ask = ++asked

    try {
      const response = await ownFetch(win, ROUTES_URL, { cache: 'no-store' })

      if (ask !== asked)
        return

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      const listed = await response.json() as DevRoutes

      if (ask !== asked)
        return

      routes = listed.routes
      notes = listed.notes
      render()
    }
    catch (error) {
      if (ask !== asked)
        return

      body.replaceChildren(tool.make('div', 'empty', `Could not list the routes: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  tab.panel.append(bar.element, body)
  win.addEventListener(BUILT_EVENT, () => {
    if (tab.panel.hidden === false)
      void list()
  }, { signal: tool.kit.signal })

  return () => void list()
}

function routeRow(tool: DevTool, route: DevRoute, here: Location): HTMLElement {
  const name = route.href === undefined ? tool.make('span', 'name', route.path) : Object.assign(tool.make('a', 'name', route.path), { href: route.href })
  const row = tool.kit.entry('route', {
    name,
    after: [...route.locale === undefined ? [] : [tool.make('span', 'chip', route.locale)], ...route.href === undefined ? [] : [tool.kit.copyButton('the URL', new URL(route.href, here.href).href)], ...route.docs === undefined ? [] : [docsLink(tool, { ...route, docs: route.docs })]],
    chips: [route.owner === undefined ? tool.kit.positionButton(route.file) : route.owner],
  })

  name.before(tool.make('span', 'method', route.method))

  if (route.href === here.pathname)
    row.setAttribute('aria-current', 'page')

  return row
}

// A link to where the docs site says what a route of kay's is for.
function docsLink(tool: DevTool, route: DevRoute & { docs: string }): HTMLAnchorElement {
  const link = tool.make('a', 'chip', 'docs')

  link.href = DOCS_ORIGIN + route.docs
  link.setAttribute('aria-label', `Docs for ${route.path}`)
  link.target = '_blank'
  link.rel = 'noopener noreferrer'

  return link
}
