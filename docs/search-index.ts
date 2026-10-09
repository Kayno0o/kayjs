import { join } from 'node:path'
import { renderMarkdown } from 'kay/content'
import { loadComponents, loadLibraries } from './src/libraries'
import { loadReference } from './src/reference'

export interface SearchSection {
  page: string
  href: string
  heading?: string | undefined
  text: string
}

const GUIDES = join(import.meta.dir, 'src/content/guides')
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
async function sections(page: string, href: string, markdown: string): Promise<SearchSection[]> {
  const { html } = await renderMarkdown(markdown)
  const found: SearchSection[] = []
  let heading: string | undefined
  let anchor = ''
  let last = 0

  for (const match of html.matchAll(HEADING)) {
    found.push({ page, href: href + anchor, heading, text: plain(html.slice(last, match.index)) })
    heading = plain(match[3]!)
    anchor = `#${match[2]}`
    last = match.index + match[0].length
  }

  found.push({ page, href: href + anchor, heading, text: plain(html.slice(last)) })

  return found.filter(section => section.heading !== undefined || section.text !== '')
}

const guides = await Promise.all([...new Bun.Glob('*.md').scanSync(GUIDES)].map(async (file) => {
  const source = await Bun.file(join(GUIDES, file)).text()
  const data = Bun.YAML.parse(FRONTMATTER.exec(source)?.[1] ?? '') as { title: string, order: number }

  return { slug: file.replace(/\.md$/, ''), data, body: source.replace(FRONTMATTER, '') }
}))

guides.sort((a, b) => a.data.order - b.data.order)

const index = [
  ...(await Promise.all(guides.map(async guide => sections(guide.data.title, `/guides/${guide.slug}`, guide.body)))).flat(),
  ...(await Promise.all((await loadReference()).map(async topic => sections(topic.data.title, topic.slug === 'overview' ? '/' : `/reference/${topic.slug}`, topic.body)))).flat(),
  ...(await Promise.all((await loadLibraries()).map(async library => sections(library.data.title, `/libraries/${library.slug}`, library.body)))).flat(),
  // A component's prose is its library's, indexed there already, so its own entry holds what only its page shows: the props.
  ...(await loadComponents()).map(component => ({ page: component.data.title, href: `/ui/${component.slug}`, text: ['kayjs-ui component.', ...component.data.props.map(prop => [prop.name, prop.comment].filter(Boolean).join(': '))].join(' ') })),
]

await Bun.write(join(import.meta.dir, 'public/search.json'), JSON.stringify(index))
