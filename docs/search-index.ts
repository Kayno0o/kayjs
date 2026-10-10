import { join } from 'node:path'
import { renderMarkdown } from 'kay/content'
import { loadComponents, loadLibraries } from './src/libraries'
import { llmsHref, loadReference } from './src/reference'

export interface SearchSection {
  page: string
  // The title alone, where `page` adds the part of the site it belongs to.
  title: string
  href: string
  heading?: string | undefined
  text: string
  // Written for agents: listed after every page written for people.
  reference?: true
}

const DOCS = join(import.meta.dir, 'src/content/docs')
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/
const HEADING = /<h([1-4]) id="([^"]+)">([\s\S]*?)<\/h\1>/g
// Block tags part words, inline ones such as code sit inside a sentence.
const BLOCK_TAGS = /<\/?(?:p|li|ul|ol|pre|h[1-6]|table|tr|td|th|blockquote|div|br)\b[^>]*>/g
const TAGS = /<[^>]+>/g
const ENTITY = /&(?:amp|lt|gt|quot|#39|#(\d+));/g
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' }
const SPACES = /\s+/g

const plain = (html: string) => html.replace(BLOCK_TAGS, ' ').replace(TAGS, '').replace(ENTITY, (entity, code?: string) => code === undefined ? ENTITIES[entity]! : String.fromCodePoint(Number(code))).replace(SPACES, ' ').trim()

// One entry for the text above a page's first heading, then one per heading down to h4, each linking the heading's own anchor.
async function sections(page: Pick<SearchSection, 'page' | 'title' | 'reference'>, href: string, markdown: string): Promise<SearchSection[]> {
  const { html } = await renderMarkdown(markdown)
  const found: SearchSection[] = []
  let heading: string | undefined
  let anchor = ''
  let last = 0

  for (const match of html.matchAll(HEADING)) {
    found.push({ ...page, href: href + anchor, heading, text: plain(html.slice(last, match.index)) })
    heading = plain(match[3]!)
    anchor = `#${match[2]}`
    last = match.index + match[0].length
  }

  found.push({ ...page, href: href + anchor, heading, text: plain(html.slice(last)) })

  return found.filter(section => section.heading !== undefined || section.text !== '')
}

const docs = await Promise.all([...new Bun.Glob('*/*.md').scanSync(DOCS)].map(async (file) => {
  const source = await Bun.file(join(DOCS, file)).text()
  const data = Bun.YAML.parse(FRONTMATTER.exec(source)?.[1] ?? '') as { title: string }

  return { slug: file.replace(/\.md$/, ''), data, body: source.replace(FRONTMATTER, '') }
}))

const index = [
  ...(await Promise.all(docs.map(async page => sections({ page: page.data.title, title: page.data.title }, `/${page.slug}`, page.body)))).flat(),
  ...(await Promise.all((await loadComponents()).map(async component => sections({ page: `${component.data.title} · kayjs-ui`, title: component.data.title }, `/ui/${component.slug}`, [component.data.description, component.body].join('\n\n'))))).flat(),
  ...(await Promise.all([...await loadReference(), ...await loadLibraries()].map(async topic => sections({ page: `${topic.data.title} · full reference`, title: topic.data.title, reference: true }, llmsHref(topic.slug), topic.body)))).flat(),
]

await Bun.write(join(import.meta.dir, 'public/search.json'), JSON.stringify(index))
