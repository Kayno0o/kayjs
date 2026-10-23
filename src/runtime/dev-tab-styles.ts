import type { DevTab, DevTool } from './dev-tool'

// The Styles tab's code, fetched the first time the tab opens: the component under the pointer, its parts with their recipe classes and what `src/ui.ts` sets over them, its variants and the theme tokens its classes name, and a box per part writing the classes to `src/ui.ts`. It imports types only, as the browser loads it as it is.
interface StyleView {
  name: string
  key: string
  recipe: boolean
  exists: boolean
  parts: { name: string, classes: string, set?: string | undefined }[]
  variants: Record<string, string[]>
  tokens: { name: string, value: string }[]
}

const HEADERS = { 'x-kay-dev': '1', 'content-type': 'application/json' }
const POSITION = /^(.+):\d+:\d+$/
const SOURCE = 'data-kay-src'
// How many components up from the element under the pointer are tried before giving up.
const CLIMB = 12

const failure = (error: unknown) => error instanceof Error ? error.message : String(error)

async function ask<Answer>(url: string, init?: RequestInit): Promise<Answer | undefined> {
  const response = await fetch(url, { cache: 'no-store', headers: HEADERS, ...init })
  let answer = {} as Answer & { error?: string }

  try {
    answer = await response.json() as typeof answer
  }
  catch {
    // An empty or non-JSON body: the status below says what happened.
  }

  if (response.status === 404)
    return undefined

  if (!response.ok)
    throw new Error(answer.error ?? `the server answered ${response.status}`)

  return answer
}

export default function stylesTab(tool: DevTool, tab: DevTab): () => void {
  const status = tool.make('div', 'note', 'Hover a component of the page to see what src/ui.ts can restyle in it.')
  const body = tool.make('div', 'stack')
  const views = new Map<string, StyleView | null>()
  const host = tool.root.host
  let shown: string | undefined
  let shownPart: string | undefined
  let asked = 0

  const lookup = async (file: string): Promise<StyleView | undefined> => {
    if (!views.has(file))
      views.set(file, await ask<StyleView>(`/_kay/dev/ui?file=${encodeURIComponent(file)}`) ?? null)

    return views.get(file) ?? undefined
  }

  const save = async (file: string, part: string, classes: string, button: HTMLButtonElement) => {
    button.disabled = true

    try {
      const done = await ask<{ key: string, created: boolean }>('/_kay/dev/ui', { method: 'POST', body: JSON.stringify({ file, part, classes }) })

      status.textContent = `${done?.created ? 'Created src/ui.ts with' : 'Wrote'} ${part} of ${done?.key} to src/ui.ts.`
      views.delete(file)
    }
    catch (error) {
      status.textContent = `Could not write src/ui.ts: ${failure(error)}`
    }

    button.disabled = false
  }

  const render = (file: string, view: StyleView, part: string | undefined) => {
    const heading = tool.make('h3', 'heading', view.name)
    const rows = view.parts.map((entry) => {
      const row = tool.make('div', 'row')
      const name = tool.make('div', 'actions')
      const input = tool.make('textarea', 'query')
      const button = tool.make('button', 'tool', 'Write')

      name.append(tool.make('span', entry.name === part ? 'pill accent' : 'pill', entry.name))
      input.rows = 1
      input.style.minHeight = '2.5rem'
      input.value = entry.set ?? ''
      input.placeholder = entry.classes === '' ? 'classes' : `over: ${entry.classes}`
      input.setAttribute('aria-label', `Classes of ${view.name} ${entry.name}`)
      button.type = 'button'
      button.title = `Set ${entry.name} in src/ui.ts${view.exists ? '' : ', creating it'}`
      button.onclick = () => void save(file, entry.name, input.value, button)
      name.append(button)
      row.append(name)

      if (entry.classes !== '')
        row.append(tool.make('div', 'note value', entry.classes))

      row.append(input)

      return row
    })

    const variants = Object.entries(view.variants).map(([name, values]) => {
      const line = tool.make('div', 'chips')

      line.append(tool.make('span', 'note', `${name}:`), ...values.map(value => tool.make('span', 'chip', value)))

      return line
    })

    const tokens = view.tokens.map(token => tool.make('div', 'note value', `${token.name}: ${token.value}`))

    body.replaceChildren(heading, tool.make('div', 'note', `${view.recipe ? 'Recipe' : 'Parts'}, keyed ${view.key} in src/ui.ts`), ...rows, ...variants, ...tokens)
  }

  // The nearest ancestor component, the element's own file first, that has parts to restyle.
  const find = async (start: Element): Promise<void> => {
    const id = ++asked
    let at: Element | null = start.closest(`[${SOURCE}]`)

    for (let step = 0; step < CLIMB && at; step++) {
      const file = POSITION.exec(at.getAttribute(SOURCE) ?? '')?.[1]

      try {
        const view = file === undefined ? undefined : await lookup(file)

        if (id !== asked)
          return

        if (file !== undefined && view !== undefined) {
          const part = start.closest('[data-part]')?.getAttribute('data-part') ?? undefined

          // The same component and part is never drawn again, so a box keeps what was typed in it.
          if (shown === file && shownPart === part)
            return

          // A focused box also holds against another component or part, as crossing the page on the way to its Write button would otherwise drop the text.
          if (tool.root.activeElement !== null && body.contains(tool.root.activeElement))
            return

          shown = file
          shownPart = part
          status.textContent = ''
          render(file, view, part)

          return
        }
      }
      catch (error) {
        status.textContent = `Could not read the component: ${failure(error)}`

        return
      }

      at = at.parentElement?.closest(`[${SOURCE}]`) ?? null
    }
  }

  const doc = host.ownerDocument

  doc.addEventListener('mouseover', (event) => {
    if (tab.panel.hidden !== false || event.composedPath().includes(host) || !(event.target instanceof Element))
      return

    void find(event.target)
  })

  tab.panel.append(status, body)

  return () => {
    views.clear()

    if (shown === undefined)
      status.textContent = 'Hover a component of the page to see what src/ui.ts can restyle in it.'
  }
}
