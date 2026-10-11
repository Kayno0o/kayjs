import { withBase, withoutBase } from './base'
import { navigation } from './navigation'
import { DRAFT_ROUTE, NAVIGATE_HEADER } from './swap'

// An entry as a CMS's editor has it before saving, by the name the content config exports its collection under: its data, and its Markdown body when it changed.
export interface DraftEntry {
  collection: string
  slug: string
  // The entry's locale, which each entry of a localized collection has and no other does.
  locale?: string | undefined
  data: unknown
  body?: string | undefined
}

// Where a draft fails its collection's schema, by its field's dotted path, `tags.0`; `''` for the data as a whole, or for its Markdown body with `body` set, which no data field named `body` is taken for.
export interface DraftIssue {
  collection: string
  slug: string
  locale?: string
  path: string
  body?: true
  message: string
}

let latest: AbortController | undefined

// Shows the page with `entries` in place of the saved ones, keeping scroll, focus and every island whose props did not change; or resolves where they fail their schemas, showing nothing.
// A newer call cancels this one, which then resolves `{}` and shows nothing, as does going to another page before it shows.
export async function showDraft(entries: DraftEntry[]): Promise<{ issues?: DraftIssue[] }> {
  if (typeof document === 'undefined')
    return {}

  latest?.abort()

  const controller = new AbortController()
  const token = navigation.current
  const page = shownPage()
  // A navigation started since, or one already underway that has shown its page, wins over the draft of the page it left.
  const isCurrent = () => controller === latest && token === navigation.current && shownPage() === page
  let response: Response
  let html: string

  latest = controller

  try {
    response = await fetch(withBase(DRAFT_ROUTE), { method: 'POST', headers: { 'content-type': 'application/json', [NAVIGATE_HEADER]: '1' }, body: JSON.stringify({ path: withoutBase(location.pathname) + location.search, entries }), signal: controller.signal })

    if (response.status === 422)
      return await response.json() as { issues: DraftIssue[] }

    if (!response.ok)
      throw new Error(`kay: showDraft was answered ${response.status}: ${await response.text()}`)

    html = await response.text()
  }
  catch (error) {
    if (controller.signal.aborted)
      return {}

    throw error
  }

  if (!navigation.hooks)
    throw new Error('kay: showDraft needs the page swap, which `navigation: false` in kay.config.ts turns off')

  if (!isCurrent())
    return {}

  const { show } = await import('./page-swap')

  await show({ url: location.href, type: response.headers.get('content-type') ?? '', html }, '', { intent: 'refresh', focused: document.activeElement }, isCurrent)

  return {}
}

function shownPage(): string {
  return location.origin + location.pathname + location.search
}
