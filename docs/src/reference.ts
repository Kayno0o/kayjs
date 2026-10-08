import { basename, join } from 'node:path'

export interface ReferencePage {
  slug: string
  data: { title: string, order: number }
  body: string
}

const ROOT = join(import.meta.dir, '../..')
// A line of llms.txt's list of docs, `- [Actions](llms/actions.md): ...`.
const DOC = /^- \[[^\]]+\]\((llms\/[\w-]+\.md)\)/gm
// A link to a doc, `actions.md` from another doc or `llms/server.md#locals` from llms.txt.
const DOC_LINK = /\]\((?:llms\/)?([\w-]+)\.md(#[\w-]+)?\)/g
const TITLE = /^# (.+)\n+/
const QUOTED = /^> /gm

const linked = (markdown: string) => markdown.replace(DOC_LINK, (_link, slug: string, anchor = '') => `](/reference/${slug}${anchor})`)

// llms.txt as the overview, then one page per doc it lists, in its order, links between them made links between pages.
export async function loadReference(): Promise<ReferencePage[]> {
  const index = await Bun.file(join(ROOT, 'llms.txt')).text()
  const docs = await Promise.all([...index.matchAll(DOC)].map(async ([, path]) => ({ slug: basename(path!, '.md'), text: await Bun.file(join(ROOT, path!)).text() })))

  return [
    { slug: 'overview', data: { title: 'Overview', order: 0 }, body: linked(index.replace(TITLE, '').replace(QUOTED, '')) },
    ...docs.map(({ slug, text }, index) => ({ slug, data: { title: TITLE.exec(text)?.[1] ?? slug, order: index + 1 }, body: linked(text.replace(TITLE, '')) })),
  ]
}
