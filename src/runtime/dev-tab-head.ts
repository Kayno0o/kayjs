import type { DevHead } from '../server/dev'
import type { DevTab, DevTool } from './dev-tool'

// The Head tab's code, fetched at once as its badge counts what is wrong with the page's head, with the tool's shared helpers from `tool.kit`.
const HEAD_URL = '/_kay/dev/head'
// Copied from dev-tool.ts, as a tab module imports nothing.
const HEAD_HEADER = 'x-kay-dev'
// A value the Head tab gives a copy button, as a link.
const WEB_URL = /^https?:\/\//i

// A section the "Problems only" toggle hides, as it lists no problem; copied from dev-tool.ts, whose `[data-plain]` rule reads it.
function plain<T extends HTMLElement>(element: T): T {
  element.dataset.plain = ''

  return element
}

// What a search result shows of a title before cutting it.
const TITLE_LENGTH = 60

// A length against the limit search results cut at, the bar full and amber once past it; the length alone when the limit is not known.
function meter(tool: DevTool, length: number, limit?: number): HTMLElement {
  const over = limit !== undefined && length > limit
  const element = tool.make('span', over ? 'meter over' : 'meter')
  const track = tool.make('span', 'track')

  if (limit === undefined) {
    element.append(tool.make('span', 'n', `${length} characters`))

    return element
  }

  const fill = tool.make('i')

  fill.style.width = `${Math.min(100, length / limit * 100)}%`
  track.append(fill)
  element.append(track, tool.make('span', 'n', `${length} / ${limit}${over ? ', cut in results' : ''}`))

  return element
}

// A JSON-LD block named by its type and what it is about, as `BlogPosting · Bonjour kay`.
function ldSummary(data: unknown): string {
  const first = (Array.isArray(data) ? data[0] : data) as { '@type'?: unknown, 'headline'?: unknown, 'name'?: unknown } | null
  const type = Array.isArray(first?.['@type']) ? (first['@type'] as unknown[]).join(', ') : first?.['@type']
  const about = first?.headline ?? first?.name

  return [type, about].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ') || 'JSON-LD block'
}

// A tag of the page's head, by its `name` or `property`.
function metaContent(head: HTMLHeadElement, key: string): string | undefined {
  const content = head.querySelector(`meta[name="${key}"],meta[property="${key}"]`)?.getAttribute('content')?.trim()

  return content === '' ? undefined : content
}

// The page's head as it is now: the search result it makes, its title, description, canonical link, alternates and robots tag, its og and twitter tags with the card image, and its JSON-LD blocks, each parsed or with its error; what `kay check` would flag in it comes from the server, which also says whether the sitemap lists the page. Read as the tool starts and again after each page swap, so its count is there before the tab is opened.
export default function headTab(tool: DevTool, tab: DevTab): () => void {
  const { copyButton, filterable, ownFetch, pill, signal, toolbar, withPositions } = tool.kit
  const doc = tool.root.ownerDocument
  const win = doc.defaultView!
  let reread: () => void = () => undefined
  const content = tool.make('div', 'stack')
  const bar = toolbar('Filter tags and JSON-LD', () => bar.apply(content), true)
  // A swap while a fetch is out asks again; the latest answer wins.
  let asked = 0
  const read = async () => {
    const ask = ++asked
    // One snapshot of the head, so a swap during the fetch cannot mix two heads in what is shown.
    const head = doc.head.cloneNode(true) as HTMLHeadElement
    const href = win.location.href
    const path = win.location.pathname
    const title = head.querySelector('title')?.textContent?.trim() ?? ''
    const description = metaContent(head, 'description')
    const canonical = head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
    let server: DevHead | undefined
    let failure: string | undefined

    try {
      const response = await ownFetch(win, HEAD_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ path, head: head.outerHTML }), cache: 'no-store' })

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      server = await response.json() as DevHead
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    const limit = server?.descriptionLength
    const children: Node[] = []
    const facts = tool.make('dl', 'facts')
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }
    const none = () => tool.make('span', 'note', 'none')
    const problems = server?.problems ?? []

    tab.count(problems.length, problems.some(problem => problem.severity === 'error') ? 'error' : 'warn')

    if (failure !== undefined)
      children.push(tool.make('div', 'empty', `Could not check the head: ${failure}`))

    if (problems.length > 0) {
      const list = tool.make('div', 'list')

      for (const problem of problems) {
        const error = problem.severity === 'error'
        const element = tool.make('div', `problem ${error ? 'error' : 'warn'}`)

        const text = [problem.message, problem.note, problem.help === undefined ? undefined : `help: ${problem.help}`].filter(Boolean).join('\n')

        const pre = tool.make('pre', 'mono')

        pre.append(...withPositions(text))
        element.append(tool.icon(error ? 'circle-x' : 'triangle-alert'), pre)
        list.append(filterable(element, text, true))
      }

      children.push(list)
    }

    const snippet = tool.make('div', 'preview serp')
    const clipped = limit !== undefined && description !== undefined && description.length > limit ? `${description.slice(0, limit).trimEnd()}...` : description
    const previews = plain(tool.make('div', 'previews'))
    const share = tool.make('div', 'preview')

    snippet.append(
      tool.make('span', 'cap', 'In search results'),
      tool.make('span', 'site', canonical ?? href),
      tool.make('span', 't', title === '' ? 'No title' : title),
      tool.make('span', 'd', clipped ?? 'No description'),
    )
    share.append(tool.make('span', 'cap', 'Share card, og:image'))
    previews.append(snippet, share)
    children.push(previews)

    fact('Title', ...title === '' ? [none()] : [title, meter(tool, title.length, TITLE_LENGTH)])
    fact('Description', ...description === undefined ? [none()] : [description, meter(tool, description.length, limit)])
    fact('Canonical', ...canonical === undefined ? [none()] : [tool.make('span', 'mono', canonical), copyButton('the canonical URL', canonical)])

    const alternates = [...head.querySelectorAll('link[rel="alternate"][hreflang]')].map(link => [`${link.getAttribute('hreflang')}: ${link.getAttribute('href')}`, link.getAttribute('href') ?? ''] as const)
    const chips = tool.make('span', 'chips')

    for (const [line, alternate] of alternates) {
      const chip = tool.make('span', 'chip', line)

      if (alternate !== '')
        chip.append(copyButton(`the ${line.slice(0, line.indexOf(':'))} alternate URL`, new URL(alternate, href).href))

      chips.append(chip)
    }

    fact('Alternates', alternates.length === 0 ? none() : chips)
    fact('Robots', metaContent(head, 'robots') ?? tool.make('span', 'note', 'no tag, indexable'))

    if (server !== undefined) {
      let sitemap: HTMLElement = server.sitemap === 'listed' ? pill('listed', 'ok') : pill('not listed')

      if (server.sitemap === 'error')
        sitemap = tool.make('span', 'error', `could not be read: ${server.sitemapError ?? 'unknown error'}`)
      else if (server.sitemap === 'none')
        sitemap = tool.make('span', 'note', 'none, the site has no origin (set site in kay.config.ts or SITE_URL)')

      fact('Sitemap', sitemap)
    }

    const tags = plain(tool.make('section', 'group'))

    tags.append(tool.make('h3', 'heading', 'Tags'), facts)
    children.push(tags)

    for (const [heading, prefix] of [['Open Graph', 'og:'], ['Twitter', 'twitter:']] as const) {
      const found = [...head.querySelectorAll('meta')].flatMap((meta) => {
        const key = meta.getAttribute('property') ?? meta.getAttribute('name') ?? ''

        return key.startsWith(prefix) ? [[key, meta.getAttribute('content') ?? ''] as const] : []
      })
      const group = plain(tool.make('section', 'group'))
      const table = tool.make('table', 'kv')
      const title = tool.make('h3', 'heading', heading)

      for (const [key, tagValue] of found) {
        const row = tool.make('tr')

        const value = tool.make('td', '', tagValue)

        if (WEB_URL.test(tagValue))
          value.append(copyButton(`the ${key} URL`, tagValue))

        row.append(tool.make('td', '', key), value)
        table.append(filterable(row, `${key} ${tagValue}`))
      }

      title.append(pill(String(found.length)))
      group.append(title, found.length === 0 ? tool.make('div', 'note', 'No tags.') : table)
      children.push(group)
    }

    const image = metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image')

    if (image === undefined) {
      share.append(tool.make('span', 'note', 'No og:image or twitter:image tag.'))
    }
    else {
      try {
        const url = new URL(image, href)
        const card = tool.make('img', 'card')

        // The site's own origin is not the dev server's, so the card is read from here.
        card.src = server?.site !== undefined && url.origin === new URL(server.site).origin ? `${win.location.origin}${url.pathname}${url.search}` : url.href
        card.alt = 'The social card image'
        share.append(card)
      }
      catch {
        share.append(tool.make('div', 'error', `The social card image is not a valid URL: ${image}`))
      }
    }

    const blocks = [...head.querySelectorAll('script[type="application/ld+json"]')]
    const ld = plain(tool.make('section', 'group'))
    const ldHeading = tool.make('h3', 'heading', 'JSON-LD')

    ldHeading.append(pill(String(blocks.length)))
    ld.append(ldHeading)

    for (const block of blocks) {
      try {
        const data = JSON.parse(block.textContent ?? '') as unknown
        const details = tool.make('details', 'json')
        const summary = tool.make('summary', '', ldSummary(data))

        const json = JSON.stringify(data, null, 2)

        details.append(summary, tool.make('pre', 'mono', json))
        ld.append(filterable(details, `${summary.textContent} ${json}`))
      }
      catch (error) {
        const text = `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`

        ld.append(filterable(tool.make('div', 'error', text), text, true))
      }
    }

    if (blocks.length === 0)
      ld.append(tool.make('div', 'note', 'None.'))

    children.push(ld)
    content.replaceChildren(...children, bar.empty)
    bar.apply(content)
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  let scheduled = false
  // A page swap patches the head in place, in many small changes: one read follows them.
  const swaps = new MutationObserver(() => {
    if (scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void read()
    })
  })

  swaps.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true })
  signal.addEventListener('abort', () => swaps.disconnect())
  // The tab's count is there from the start, not once it is opened.
  void read()

  return () => reread()
}
