import type { DevRequest } from '../server/dev'
import type { DevTab, DevTool } from './dev-tool'

// The i18n tab's code, fetched at once as its badge counts the missing messages, with the tool's shared helpers from `tool.kit`.
const REQUEST = 'kay-dev-request'

// The page's locale, a link to the page in each other one, and the messages no locale has; only for a site with `i18n`, whose request block lists the locales.
export default function i18nTab(tool: DevTool, tab: DevTab): () => void {
  const { missing, pill, signal } = tool.kit
  const doc = tool.root.ownerDocument
  const read = () => JSON.parse(doc.getElementById(REQUEST)?.textContent ?? 'null') as DevRequest | null
  let render: () => void = () => undefined

  render = () => {
    const request = read()

    if (request?.locales === undefined)
      return

    const facts = tool.make('dl', 'facts')
    const switcher = tool.make('dd')
    const chips = tool.make('span', 'locales')
    const messages = tool.make('section', 'group')
    const heading = tool.make('h3', 'heading', 'Missing messages')
    const keys = tool.make('ul', 'missing')

    for (const { locale, href } of request.locales) {
      const current = locale === request.locale
      const chip = current ? tool.make('span', 'locale-chip', locale) : Object.assign(tool.make('a', 'locale-chip', locale), { href })

      if (current)
        chip.setAttribute('aria-current', 'true')

      chips.append(chip)
    }

    switcher.append(chips)

    for (const key of missing.keys) {
      const item = tool.make('li')

      item.append(tool.icon('circle-x'), key)
      keys.append(item)
    }

    heading.append(pill(String(missing.keys.size), missing.keys.size > 0 ? 'error' : undefined))
    messages.append(heading, missing.keys.size === 0 ? tool.make('span', 'note', 'none') : keys)
    facts.append(tool.make('dt', '', 'Locale'), tool.make('dd', 'mono', request.locale), tool.make('dt', '', 'Page in'), switcher)
    tab.count(missing.keys.size, missing.keys.size > 0 ? 'error' : undefined)
    tab.panel.replaceChildren(facts, messages)
  }
  // A page swap brings the next page's block, and starts with the old page's problems gone.
  const blocks = new MutationObserver((records) => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (node as Element).id === REQUEST)))
      render()
  })
  const swaps = new MutationObserver(() => {
    if (doc.documentElement.hasAttribute('aria-busy'))
      missing.clear()
  })

  missing.changed = render
  render()
  blocks.observe(doc.head, { childList: true })
  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  signal.addEventListener('abort', () => {
    blocks.disconnect()
    swaps.disconnect()
  })

  return () => render()
}
