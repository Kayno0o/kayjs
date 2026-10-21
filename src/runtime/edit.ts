import type { EntryRef } from './fields'
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

// Where a draft fails its collection, by its field's dotted path, `tags.0`; `''` for the data as a whole, for its Markdown body with `body` set, or for its slug or locale as `key` names, which no data field of that name is taken for.
export interface DraftIssue {
  collection: string
  slug: string
  locale?: string
  path: string
  body?: true
  key?: 'slug' | 'locale'
  message: string
}

export type { EntryRef }

// What an extension's `editor` is given: each entry the page read, by the name the content config exports its collection under, those its head and attributes read included.
export interface EditorProps {
  entries: EntryRef[]
}

let latest: AbortController | undefined

// Shows the page with `entries` in place of the saved ones, keeping scroll, focus and every island whose props did not change; an entry failing its schema is left out, showing its saved text, and resolves where it fails.
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
  let answer: Answer
  let refused: DraftIssue[] = []

  latest = controller

  try {
    answer = await post(entries, controller.signal)

    // One entry the schema refuses leaves the others their preview: the page renders again without it, showing its saved text.
    if (answer.response.status === 422) {
      refused = (JSON.parse(answer.text) as { issues: DraftIssue[] }).issues
      answer = await post(entries.filter(entry => !refused.some(issue => issue.collection === entry.collection && issue.slug === entry.slug && issue.locale === entry.locale)), controller.signal)
    }
  }
  catch (error) {
    if (controller.signal.aborted)
      return {}

    throw error
  }

  const { response, text } = answer

  if (!isCurrent())
    return {}

  if (response.status === 422)
    return JSON.parse(text) as { issues: DraftIssue[] }

  if (!response.ok)
    throw new Error(`kay: showDraft was answered ${response.status}: ${text}`)

  if (!navigation.hooks)
    throw new Error('kay: showDraft needs the page swap, which `navigation: false` in kay.config.ts turns off')

  const { show } = await import('./page-swap')

  await show({ url: location.href, type: response.headers.get('content-type') ?? '', html: text }, '', { intent: 'refresh', focused: document.activeElement }, isCurrent)

  return refused.length > 0 ? { issues: refused } : {}
}

interface Answer { response: Response, text: string }

async function post(entries: DraftEntry[], signal: AbortSignal): Promise<Answer> {
  const response = await fetch(withBase(DRAFT_ROUTE), { method: 'POST', headers: { 'content-type': 'application/json', [NAVIGATE_HEADER]: '1' }, body: JSON.stringify({ path: withoutBase(location.pathname) + location.search, entries }), signal })

  return { response, text: await response.text() }
}

function shownPage(): string {
  return location.origin + location.pathname + location.search
}
