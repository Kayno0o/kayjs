import { basename, join } from 'node:path'

export interface ReferencePage {
  slug: string
  data: { title: string, order: number }
  body: string
}

const ROOT = join(import.meta.dir, '../..')
// A line of llms.txt's list of docs, `- [Actions](llms/actions.md): ...`.
const DOC = /^- \[[^\]]+\]\((llms\/[\w-]+\.md)\)/gm
// A link to a doc, `actions.md` from another doc or `llms/server.md#locals` from llms.txt, made a link to its page under /llms.
const DOC_LINK = /\]\((?:llms\/)?([\w-]+)\.md(#[\w-]+)?\)/g
const TITLE = /^# (.+)\n+/
const QUOTED = /^> /gm

// The reference docs the guides serve as pages of their own, so a release edits one file: `/guides/whats-new` and `/guides/upgrading`, each with the archive of its older releases.
export const LLMS_GUIDES = [
  { slug: 'guides/whats-new', topic: 'whats-new', order: 10.5, description: 'What each release of kay and its libraries adds, with a link to where each feature is documented.' },
  { slug: 'guides/whats-new-archive', topic: 'whats-new-archive', order: 10.6, listed: false, description: 'What the older releases added, with a link to where each feature is documented.' },
  { slug: 'guides/upgrading', topic: 'upgrading', order: 11, description: 'What each minor release breaks, and what to change in your app.' },
  { slug: 'guides/upgrading-archive', topic: 'upgrading-archive', order: 11.1, listed: false, description: 'What the older minor releases broke, and what to change in your app.' },
] as const

// The guides left out of the sidebar and the pagers, served and linked from the page they continue.
export const isUnlisted = (slug: string) => (LLMS_GUIDES as readonly { slug: string, listed?: boolean }[]).some(guide => guide.slug === slug && guide.listed === false)

const GUIDE_OF = new Map<string, string>(LLMS_GUIDES.map(guide => [guide.topic, `/${guide.slug}`]))

export const llmsHref = (slug: string) => slug === 'overview' ? '/llms' : `/llms/${slug}`

const linked = (markdown: string) => markdown.replace(DOC_LINK, (_link, slug: string, anchor = '') => `](${GUIDE_OF.get(slug) ?? `/llms/${slug}`}${anchor})`)

// llms.txt as the overview, then one page per doc it lists, in its order, links between them made links between pages.
export async function loadReference(): Promise<ReferencePage[]> {
  const index = await Bun.file(join(ROOT, 'llms.txt')).text()
  const docs = await Promise.all([...index.matchAll(DOC)].map(async ([, path]) => ({ slug: basename(path!, '.md'), text: await Bun.file(join(ROOT, path!)).text() })))

  return [
    { slug: 'overview', data: { title: 'Overview', order: 0 }, body: linked(index.replace(TITLE, '').replace(QUOTED, '')) },
    ...docs.map(({ slug, text }, index) => ({ slug, data: { title: TITLE.exec(text)?.[1] ?? slug, order: index + 1 }, body: linked(text.replace(TITLE, '')) })),
  ]
}
