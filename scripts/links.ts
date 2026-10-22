import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadComponents, loadLibraries } from '../docs/src/libraries'
import { CROSS_PATH_SOURCE, crossHref, LLMS_GUIDES } from '../docs/src/reference'
import { renderMarkdown } from '../src/content/markdown'

const ROOT = join(import.meta.dir, '..')
// A link to a page of the site in Markdown or a ReadMore, anchor left out: `](/essentials/routing#layouts)`, `href="/llms/server"`.
const SITE_LINK = /(?:\]\(|href=")(\/[\w/-]*?)\/?(#[\w-]*)?[)"]/g
// Code blocks and spans, whose links are examples rather than links of the site.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g

// A link between the Markdown files of llms/, `](islands.md#navigation)`, one by path into a library or another doc, `](../packages/ui/llms/forms.md)`, or into the same file, `](#navigation)`.
export const LINK = new RegExp(String.raw`\]\(((?:llms\/)?[\w-]+\.md|${CROSS_PATH_SOURCE})?(#[\w-]+)?\)`, 'g')
const CROSS = /^\.\.\//
const HOME_LINK = /href[=:] ?["'](\/[\w/-]*?)\/?(?:#([\w-]+))?["']/g
const LLMS_PREFIX = /^llms\//
const docHref = (path: string) => CROSS.test(path) ? crossHref(path) : `/llms/${path.replace(LLMS_PREFIX, '').slice(0, -'.md'.length)}`
const ARCHIVE_PAGE = /^llms\/[\w-]+-archive\.md$/
const ARCHIVE_ADVICE = 'an archive loses its oldest sections at a release: link the page, or the current one'
const ARCHIVE_ANCHOR = /-archive\.md#/

// The heading ids of a page, per process and keyed by its text: a page that is overridden or edited since is another text, so it renders fresh while the others are not rendered again on each call.
const HEADINGS = new Map<string, Set<string>>()

async function headingIds(markdown: string) {
  let ids = HEADINGS.get(markdown)

  if (ids === undefined) {
    ids = new Set((await renderMarkdown(markdown)).headings.map(heading => heading.id))
    HEADINGS.set(markdown, ids)
  }

  return ids
}

// The links of llms.txt, llms/, the docs content, the library references and the home page that no page of the site answers, each as `file: /path#anchor`.
// `overrides` replaces the text of files under llms/ and llms.txt (by path from the repo root), so a release checks the pages it is about to write before it writes them.
export async function brokenLinks(overrides: ReadonlyMap<string, string> = new Map()): Promise<string[]> {
  const read = async (file: string) => overrides.get(file) ?? await Bun.file(join(ROOT, file)).text()
  const docs = (await readdir(join(ROOT, 'llms'))).filter(name => name.endsWith('.md')).sort()
  const llms = await read('llms.txt')
  const docsRoot = join(ROOT, 'docs/src/content')
  const files = [...new Bun.Glob('**/*.md').scanSync(docsRoot)]
  const served = new Map<string, Set<string> | undefined>([['/', undefined], ['/llms', undefined]])
  const headings = headingIds

  for (const file of files.filter(file => file.startsWith('docs/')))
    served.set(`/${file.slice('docs/'.length, -'.md'.length)}`, await headings(await Bun.file(join(docsRoot, file)).text()))

  for (const component of await loadComponents({ withProps: false }))
    served.set(`/ui/${component.slug}`, await headings(component.body))

  for (const name of docs)
    served.set(`/llms/${name.slice(0, -'.md'.length)}`, await headings(await read(`llms/${name}`)))

  const libraries = await loadLibraries()

  for (const library of libraries)
    served.set(`/llms/${library.slug}`, await headings(library.body))

  for (const guide of LLMS_GUIDES)
    served.set(`/${guide.slug}`, served.get(`/llms/${guide.topic}`))

  served.set('/llms.txt', await headings(llms))

  const broken: string[] = []
  const resolve = (from: string, path: string, anchor: string | undefined) => {
    if (!served.has(path) || (anchor !== undefined && !served.get(path)?.has(anchor)))
      broken.push(`${from}: ${path}${anchor === undefined ? '' : `#${anchor}`}`)
  }

  // llms.txt and llms/: links between the Markdown files, which the site serves as pages.
  for (const file of ['llms.txt', ...docs.map(name => `llms/${name}`)]) {
    const own = file === 'llms.txt' ? '/llms.txt' : `/${file.slice(0, -'.md'.length)}`

    for (const [, path, anchor] of (await read(file)).matchAll(LINK)) {
      resolve(file, path === undefined ? own : docHref(path), anchor?.slice(1))

      // An archive drops its oldest releases at a release, so a link into one by anchor goes stale.
      if (path !== undefined && anchor !== undefined && ARCHIVE_ANCHOR.test(`${path}${anchor}`) && !ARCHIVE_PAGE.test(file))
        broken.push(`${file}: ${path}${anchor} (${ARCHIVE_ADVICE})`)
    }
  }

  // The docs content: links to pages of the site, outside code.
  for (const file of files) {
    for (const [, path, anchor] of (await Bun.file(join(docsRoot, file)).text()).replace(CODE, '').matchAll(SITE_LINK)) {
      resolve(file, path!, anchor?.slice(1))

      if (anchor !== undefined && path!.endsWith('-archive'))
        broken.push(`${file}: ${path}${anchor} (${ARCHIVE_ADVICE})`)
    }
  }

  // The libraries' llms.txt and topic files, whose links to kay's pages are made links to the site's.
  for (const library of libraries) {
    for (const [, path, anchor] of library.body.replace(CODE, '').matchAll(SITE_LINK)) {
      const from = `packages/${library.data.library}/${library.data.source}`

      resolve(from, path!, anchor?.slice(1))

      if (anchor !== undefined && path!.endsWith('-archive'))
        broken.push(`${from}: ${path}${anchor} (${ARCHIVE_ADVICE})`)
    }
  }

  // The home page: its cards, features and buttons.
  const home = await Bun.file(join(ROOT, 'docs/src/routes/(docs)/index.kay')).text()

  for (const [, path, anchor] of home.matchAll(HOME_LINK))
    resolve('the home page', path!, anchor)

  return broken
}
