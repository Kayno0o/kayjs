import type { LintLevels, LintName } from '../compiler/lints'
import type { FaviconConfig, SeoConfig } from '../config'
import type { Stop } from '../server/pure-page'
import type { CheckDiagnostic } from './index'
import { lintLevel } from '../compiler/lints'
import { localizedTexts } from '../runtime/localized'

// What search results show of a description before cutting it.
export const DESCRIPTION_LENGTH = 160
const ENTITY = /&(?:amp|lt|gt|quot|#39|#x27);/g
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#x27;': '\'' }

export const NOINDEX = /(?:^|,)\s*noindex\s*(?:,|$)/i

export interface SiteSeo {
  site?: string | undefined
  seo?: SeoConfig | undefined
  favicon?: string | FaviconConfig | false | undefined
  lints?: LintLevels | undefined
}

// A page `kay build` prerendered, with what its head says.
export interface RenderedPage {
  path: string
  // The page's module, which a problem points at.
  file: string
  locale?: string | undefined
  html: string
  // Whether its module exports `noindex = true`, or a `sitemap` deciding whether the sitemap lists it.
  noindex: boolean
  sitemap: boolean
  // What its words weigh in the search index; false when it is left out, by a guard covering it, `noindex` or `search: false`.
  search: number | false
}

interface Head {
  title?: string | undefined
  description?: string | undefined
  image?: string | undefined
  imageWidth: boolean
  noindex: boolean
}

// A site search engines and social networks read: one with `site` or `seo` set, or exported to a static host. The `seo` lints say nothing of any other unless `lints` turns them on.
export function isPublicSite(config: SiteSeo, exported = false): boolean {
  return config.site !== undefined || config.seo !== undefined || exported
}

// What kay.config.ts leaves out of a public site's head; `sources` are the project's .kay files, any of which may set an `og:image`. A missing site only counts for a static export, a server reading `SITE_URL` at boot.
export function configSeoLints(config: SiteSeo, file: string, sources: Iterable<string>, exported = false): CheckDiagnostic[] {
  const found: CheckDiagnostic[] = []
  const report = lintReporter(config, false, found)
  const at = { file, line: 1, column: 1 }

  if (exported && config.seo !== undefined && config.site === undefined)
    report('missing-site', { ...at, message: '`seo` is set, but not the origin the site is public at', note: 'pages get no canonical link or `og:url`, and the site no sitemap or robots.txt', help: 'set `site: \'https://example.com\'`, or `SITE_URL` (or `ORIGIN`) where the site builds' })

  const descriptions = localizedTexts(config.seo?.description)

  if (descriptions.length === 0)
    report('missing-description', { ...at, message: 'The site has no description', note: 'a page setting none of its own goes without', help: 'set `seo.description` to a sentence saying what the site is' })

  const record = typeof config.seo?.description === 'object' ? Object.entries(config.seo.description) : []

  for (const [locale, description] of record.length > 0 ? record : descriptions.map(text => ['', text] as const)) {
    if (description.length <= DESCRIPTION_LENGTH)
      continue

    report('long-description', { ...at, message: `The site description \`seo.description\`${locale === '' ? '' : ` for ${locale}`} runs ${description.length} characters`, note: `search results cut it after about ${DESCRIPTION_LENGTH}, on every page that sets none of its own`, help: 'shorten it to a sentence or two' })
  }

  if (config.seo?.image === undefined && ![...sources].some(source => source.includes('og:image')))
    report('missing-share-image', { ...at, message: 'No page has a share image', note: 'a link shared to a social network shows no picture', help: 'set `seo.image`, or an `og:image` per page with `shareCard()` from `kay/image`' })

  if (config.favicon === undefined)
    report('default-favicon', { ...at, message: 'The site shows kay\'s mark as its favicon', help: 'set `favicon` to a square image of the site\'s own, 512 pixels or more, or a square SVG' })

  return found
}

// What the heads of a public site's prerendered pages leave out or repeat.
export function pageSeoLints(config: SiteSeo, pages: RenderedPage[], exported = false): CheckDiagnostic[] {
  const found: CheckDiagnostic[] = []
  const report = lintReporter(config, exported, found)
  const titles = new Map<string, string>()

  for (const page of pages) {
    const head = readHead(page.html)
    const at = { file: page.file, line: 1, column: 1 }

    if (head.title === undefined) {
      report('untitled-page', { ...at, message: `\`${page.path}\` has no title`, help: 'set one with `title` in a `head` block, or `seo.name` for every page' })
    }
    else {
      const key = `${page.locale ?? ''}\n${head.title}`
      const first = titles.get(key)

      if (first === undefined)
        titles.set(key, page.path)
      else
        report('duplicate-title', { ...at, message: `\`${page.path}\` has the title of \`${first}\`, "${head.title}"`, help: 'name what sets this page apart in its title' })
    }

    if (head.description === undefined)
      report('undescribed-page', { ...at, message: `\`${page.path}\` has no description`, help: 'set `meta(name="description" content="...")` in a `head` block, or `seo.description` for every page' })
    // The site's own description is told once, in kay.config.ts, not at every page that inherits it.
    else if (head.description.length > DESCRIPTION_LENGTH && !localizedTexts(config.seo?.description).includes(head.description))
      report('long-description', { ...at, message: `The description of \`${page.path}\` runs ${head.description.length} characters`, note: `search results cut it after about ${DESCRIPTION_LENGTH}`, help: 'shorten it to a sentence or two' })

    if (head.image !== undefined && !head.imageWidth)
      report('unsized-share-image', { ...at, message: `The share image of \`${page.path}\` has no size`, note: `kay reads no size off ${head.image}, so a network fetches it before laying the card out`, help: 'link a public file, an imported image, `shareImage()` or `shareCard()`, or set `og:image:width` and `og:image:height`' })

    if (head.noindex && !page.noindex && !page.sitemap && config.site !== undefined)
      report('noindex-in-sitemap', { ...at, message: `\`${page.path}\` is in the sitemap, though its head says \`noindex\``, help: '`export const page = { noindex: true }` in its server fence sets the tag and leaves it out of the sitemap' })
  }

  return found
}

// The pages that said `keep: true` and were not kept, each at the line that stopped it.
export function unkeptPageLints(config: Pick<SiteSeo, 'lints'>, stops: (Stop & { keep: boolean, route: string, fix?: string | undefined })[]): CheckDiagnostic[] {
  const level = lintLevel('unkept-page', config.lints)

  if (level === 'allow')
    return []

  return stops.filter(stop => stop.keep).map(stop => ({ file: stop.file, line: Math.max(stop.line, 1), column: 1, code: 'unkept-page', severity: level === 'warn' ? 'warning' : 'error', message: `The build does not keep \`${stop.route}\`, though it says \`keep: true\`: ${stop.why}`, help: stop.fix ?? 'drop what it reads or imports, or remove `keep` and let it render per request' }))
}

// Pushes a lint at the level the config gives it, the `seo` lints allowed on a site that is not public.
export function lintReporter(config: SiteSeo, exported: boolean, found: CheckDiagnostic[]): (name: LintName, problem: Omit<CheckDiagnostic, 'code' | 'severity'>) => void {
  const fallback = isPublicSite(config, exported) ? undefined : 'allow'

  return (name, problem) => {
    const level = lintLevel(name, config.lints, fallback)

    if (level !== 'allow')
      found.push({ ...problem, code: name, severity: level === 'warn' ? 'warning' : 'error' })
  }
}

function readHead(html: string): Head {
  const head: Head = { imageWidth: false, noindex: false }
  let title: string | undefined

  new HTMLRewriter()
    .on('head > title', { text: (text) => { title = (title ?? '') + text.text } })
    .on('head > meta', {
      element: (element) => {
        const name = element.getAttribute('name') ?? element.getAttribute('property')
        const content = decode(element.getAttribute('content') ?? '').trim()

        if (name === 'description')
          head.description = content === '' ? undefined : content
        else if (name === 'og:image')
          head.image = content
        else if (name === 'og:image:width')
          head.imageWidth = true
        else if (name === 'robots' && NOINDEX.test(content))
          head.noindex = true
      },
    })
    .transform(html)

  const text = decode(title ?? '').trim()

  head.title = text === '' ? undefined : text

  return head
}

export function decode(text: string): string {
  return text.replace(ENTITY, entity => ENTITIES[entity]!)
}
