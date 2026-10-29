import type { DevNotFound } from '../server/dev-not-found'
import type { DevTab, DevTool } from './dev-tool'

// The Not found tab's code, fetched at once as its badge counts the missing paths, with the tool's shared helpers from `tool.kit`.
const NOT_FOUND_URL = '/_kay/dev/not-found'
// Copied from dev-tool.ts, as a tab module imports nothing.
const HEAD_HEADER = 'x-kay-dev'
const BUILT_EVENT = 'kay-dev-built'
const REFERRER_LIMIT = 3

// The paths a production run recorded visitors found nothing at, most hit first, each with the hosts they came from and the target kay suggests; a click writes the redirect into kay.config.ts, as `kay not-found --redirect` does. Fetched as the tab shows and again after each restart.
export default function notFoundTab(tool: DevTool, tab: DevTab): () => void {
  const { entry, filterable, ownFetch, pill, signal, toolbar } = tool.kit
  const win = tool.root.ownerDocument.defaultView!
  const body = tool.make('div', 'list')
  const status = tool.make('div', 'note')
  let asked = 0
  let reread: () => void = () => undefined
  const redirect = async (path: string, to: string, row: HTMLElement) => {
    try {
      const response = await ownFetch(win, NOT_FOUND_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ path, ...to === '' ? {} : { to } }), cache: 'no-store' })
      const answer = await response.json() as { error?: string, redirect?: { from: string, to: string } }

      if (!response.ok || answer.redirect === undefined)
        throw new Error(answer.error ?? `the server answered ${response.status}`)

      status.textContent = `Added to kay.config.ts: ${answer.redirect.from} to ${answer.redirect.to}. kay dev restarts to serve it.`
      row.remove()
    }
    catch (error) {
      status.textContent = `Could not add the redirect: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const missingRow = (missing: DevNotFound['missing'][number]) => {
    const input = tool.make('input', 'filter')
    const add = tool.make('button', 'tool', 'Add redirect')
    const actions = tool.make('div', 'actions')
    const row = entry('missing', {
      name: missing.path,
      after: [pill(`${missing.hits} hit${missing.hits === 1 ? '' : 's'}`, 'accent')],
      chips: [...new Set(missing.referrers.map(({ host }) => host))].slice(0, REFERRER_LIMIT).map(host => `from ${host}`).concat(new Set(missing.referrers.map(({ host }) => host)).size > REFERRER_LIMIT ? ['...'] : []),
      note: missing.target === undefined ? 'No target suggested: name one to redirect.' : `Suggested target (${missing.reason}): ${missing.target}`,
    })

    input.type = 'text'
    input.value = missing.target ?? ''
    input.placeholder = '/new-path'
    input.setAttribute('aria-label', `Redirect target of ${missing.path}`)
    add.type = 'button'
    add.onclick = async () => {
      add.disabled = true
      await redirect(missing.path, input.value.trim(), row)
      add.disabled = false
    }
    actions.append(input, add)
    row.querySelector('.body')!.append(actions)

    return filterable(row, missing.path)
  }
  const bar = toolbar('Filter by path', () => bar.apply(body))
  const list = async () => {
    const ask = ++asked

    try {
      const response = await ownFetch(win, NOT_FOUND_URL, { cache: 'no-store' })

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      const listed = await response.json() as DevNotFound

      if (ask !== asked)
        return

      tab.count(listed.missing.length)
      bar.element.hidden = listed.missing.length === 0

      if (!listed.recorded)
        body.replaceChildren(tool.make('div', 'empty', `No ${listed.file} here: the production server records the pages visitors asked for and found nothing at, and kay dev records none.`))
      else if (listed.missing.length === 0)
        body.replaceChildren(tool.make('div', 'empty', 'Every recorded path has a redirect.'))
      else
        body.replaceChildren(...listed.missing.map(missingRow), bar.empty)

      bar.apply(body)
    }
    catch (error) {
      if (ask === asked)
        body.replaceChildren(tool.make('div', 'empty', `Could not list the missing paths: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  reread = () => void list()
  tab.panel.append(bar.element, status, body)
  win.addEventListener(BUILT_EVENT, reread, { signal })
  reread()

  return () => reread()
}
