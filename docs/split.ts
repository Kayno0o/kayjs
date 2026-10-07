import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Writes each `##` section of llms.txt as a Markdown entry of the `reference` collection, and its opening as the overview the home page shows, so the site and the file an agent reads never drift.
// Run before the site builds or checks: `bun docs/split.ts`.

export interface Topic {
  slug: string
  title: string
  body: string
}

const LLMS = join(import.meta.dir, '../llms.txt')
const OUT = join(import.meta.dir, 'src/content/reference')
const SECTION = /^## (.+)$/m
// A section's `###` headings sit right under the page's title.
const SUBSECTION = /^### /gm
const CODE_SPAN = /`([^`]*)`/g
const NOT_SLUG = /[^a-z0-9]+/g
const EDGE_DASHES = /^-|-$/g
// `(see Navigation)`, `(see Actions and Locales)`: a pointer to another section, linked to its page.
const SEE = /\(see ([^)]+)\)/g
// The names a pointer lists, with what joins them kept.
const AND = /(, | and )/
// The opening's title, which the home page gives itself, and the quote marks of its summary.
const TITLE = /^# .+\n+/
const QUOTED = /^> /gm

export function slugOf(title: string): string {
  return title.replace(CODE_SPAN, '$1').toLowerCase().replace(NOT_SLUG, '-').replace(EDGE_DASHES, '')
}

// The opening, before the first section, then one topic per section in the file's order.
export function splitReference(text: string): { opening: string, topics: Topic[] } {
  const [opening = '', ...parts] = text.split(SECTION)
  const topics: Topic[] = []

  for (let index = 0; index < parts.length; index += 2) {
    const title = parts[index]!.trim()

    topics.push({ slug: slugOf(title), title, body: parts[index + 1]!.trim().replace(SUBSECTION, '## ') })
  }

  const titles = new Map(topics.map(topic => [topic.title.toLowerCase(), topic.slug]))
  // A name that is no section stays as written.
  const linked = (body: string) => body.replace(SEE, (whole, names: string) => {
    const parts = names.split(AND)
    const listed = parts.filter((_part, index) => index % 2 === 0)

    return listed.every(name => titles.has(name.trim().toLowerCase())) ? `(see ${parts.map((part, index) => index % 2 === 0 ? `[${part.trim()}](/reference/${titles.get(part.trim().toLowerCase())})` : part).join('')})` : whole
  })

  return { opening: opening.trim(), topics: topics.map(topic => ({ ...topic, body: linked(topic.body) })) }
}

function entry(title: string, order: number, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\norder: ${order}\n---\n\n${body}\n`
}

// Writes the pages, the folder cleared first; gives how many.
export async function writeReference(): Promise<number> {
  const { opening, topics } = splitReference(await Bun.file(LLMS).text())

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await Promise.all([
    Bun.write(join(OUT, 'overview.md'), entry('Overview', 0, opening.replace(TITLE, '').replace(QUOTED, ''))),
    ...topics.map(async (topic, index) => Bun.write(join(OUT, `${topic.slug}.md`), entry(topic.title, index + 1, topic.body))),
  ])

  return topics.length + 1
}

if (import.meta.main)
  console.log(`wrote ${await writeReference()} pages to ${OUT}`)
