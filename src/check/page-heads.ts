import type { ElementNode, KayFile, Node } from '../compiler/ast'
import type { Route } from '../server/routes'
import type { CheckDiagnostic, CheckOptions } from './index'
import { sep } from 'node:path'
import { childBlocks, isHead } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { localizedText, localizedTexts } from '../runtime/localized'
import { cardImageSizes } from '../server/seo'
import { decode, DESCRIPTION_LENGTH, isPublicSite, lintReporter, NOINDEX, TITLE_LENGTH } from './seo'

// A value a head tag gives, with its text when the template writes it as a string; an expression is present, its value unknown.
interface Given {
  text: string | undefined
}

// What the head blocks of a page and its layouts give, read as written, the innermost first.
interface HeadFacts {
  // `wrapped` is false for a title the `seo.titleTemplate` is not known to wrap: marked `raw`, or with attributes that may mark it.
  title?: (Given & { wrapped: boolean }) | undefined
  description?: Given | undefined
  image?: Given | undefined
  imageWidth: boolean
  robots?: Given | undefined
  // A `meta` whose name is no string: it may be any of the above.
  unknownMeta: boolean
}

interface Chain {
  file: string
  facts: HeadFacts
}

// The prerendered pages' head lints, read off the templates instead of the HTML `kay build` renders: a tag whose value is an expression counts as given and is judged by nothing but its presence.
// Only the pages whose server fence says `prerender` are read, as the build renders those alone, or every page of an export.
export async function pageHeadLints(options: CheckOptions, routes: Route[], routesDir: string, publicDir: string): Promise<CheckDiagnostic[]> {
  const exported = options.exported === true

  // `kay build` sets `launch` and reads the rendered heads itself.
  if (options.launch === true || (!isPublicSite(options, exported) && options.lints === undefined))
    return []

  const found: CheckDiagnostic[] = []
  const report = lintReporter(options, exported, found)
  // A source read gives no locale, so a per-locale default reads the default locale's text.
  const defaultLocale = options.i18n?.defaultLocale
  const siteName = localizedText(options.seo?.name, undefined, defaultLocale)
  const titleTemplate = localizedText(options.seo?.titleTemplate, undefined, defaultLocale)
  const siteImage = localizedText(options.seo?.image, undefined, defaultLocale)
  const siteDescriptions = localizedTexts(options.seo?.description)
  const sources = new Map<string, { file: KayFile, prerender: string | undefined, noindex: string | undefined, sitemap: boolean }>()
  const read = async (path: string) => {
    let known = sources.get(path)

    if (known === undefined) {
      const source = await Bun.file(path).text()
      const file = parseKay(source)
      const settings = analyzeServer(source, file.server)?.page?.settings
      const text = (name: string) => {
        const value = settings?.get(name)?.value

        return value === undefined ? undefined : source.slice(value.start, value.end).trim()
      }

      known = { file, prerender: text('prerender'), noindex: text('noindex'), sitemap: settings?.has('sitemap') === true }
      sources.set(path, known)
    }

    return known
  }
  const titles = new Map<string, string>()
  const descriptions = new Map<string, string>()
  const own = routes.filter(route => route.file.startsWith(routesDir + sep))
  const sizeOf = await cardImageSizes(publicDir)

  for (const route of own.sort((a, b) => a.pattern.localeCompare(b.pattern))) {
    const page = await read(route.file)

    // A static export renders every page without params that does not opt out, `kay build` those that say `prerender`.
    if (page.prerender === 'false' || (page.prerender === undefined && !(exported && route.params.length === 0)))
      continue

    const chain: Chain[] = []
    // The innermost `noindex` of the page and its layouts, as the server reads it.
    let noindex: string | undefined

    for (const file of [route.file, ...[...route.layouts].reverse()]) {
      const source = await read(file)

      noindex ??= source.noindex
      chain.push({ file, facts: headFacts(source.file) })
    }

    const facts = merge(chain.map(entry => entry.facts))
    const at = { file: route.file, line: 1, column: 1 }
    const title = facts.title === undefined ? siteName : facts.title.text
    // A page kept out of search results has no snippet to cut or to tell from another.
    const indexed = noindex !== 'true' && !(facts.robots?.text !== undefined && NOINDEX.test(facts.robots.text))

    if (facts.title === undefined && siteName === undefined) {
      report('untitled-page', { ...at, message: `\`${route.pattern}\` has no title`, help: 'set one with `title` in a `head` block, or `seo.name` for every page' })
    }
    else if (title !== undefined) {
      const first = titles.get(title)

      if (first === undefined)
        titles.set(title, route.pattern)
      else
        report('duplicate-title', { ...at, message: `\`${route.pattern}\` has the title of \`${first}\`, "${title}"`, help: 'name what sets this page apart in its title' })

      // The title the browser shows is the page's in the site's template, as `kay build` measures it.
      const shown = facts.title !== undefined && facts.title.wrapped && titleTemplate !== undefined && titleTemplate !== '' ? titleTemplate.replaceAll('%s', () => title) : title

      if (indexed && facts.title !== undefined && shown.length > TITLE_LENGTH)
        report('long-title', { ...at, message: `The title of \`${route.pattern}\` runs ${shown.length} characters`, note: `search results cut it after about ${TITLE_LENGTH}${shown === title ? '' : ', `seo.titleTemplate` included'}`, help: 'shorten it to what names the page' })
    }

    const description = facts.description?.text

    if (facts.description === undefined && !facts.unknownMeta && siteDescriptions.length === 0) {
      report('undescribed-page', { ...at, message: `\`${route.pattern}\` has no description`, help: 'set `meta(name="description" content="...")` in a `head` block, or `seo.description` for every page' })
    }
    else if (description !== undefined && !siteDescriptions.includes(description)) {
      if (indexed) {
        const first = descriptions.get(description)

        if (first === undefined)
          descriptions.set(description, route.pattern)
        else
          report('duplicate-description', { ...at, message: `\`${route.pattern}\` has the description of \`${first}\`, "${description}"`, help: 'say what sets this page apart in its description' })
      }

      if (description.length > DESCRIPTION_LENGTH)
        report('long-description', { ...at, message: `The description of \`${route.pattern}\` runs ${description.length} characters`, note: `search results cut it after about ${DESCRIPTION_LENGTH}`, help: 'shorten it to a sentence or two' })
    }

    const image = facts.image === undefined ? siteImage : facts.image.text

    if (image !== undefined && !facts.imageWidth && sizeOf(image) === undefined)
      report('unsized-share-image', { ...at, message: `The share image of \`${route.pattern}\` has no size`, note: `kay reads no size off ${image}, so a network fetches it before laying the card out`, help: 'link a public file, an imported image, `shareImage()` or `shareCard()`, or set `og:image:width` and `og:image:height`' })

    if (facts.robots?.text !== undefined && NOINDEX.test(facts.robots.text) && noindex !== 'true' && !page.sitemap && options.site !== undefined)
      report('noindex-in-sitemap', { ...at, message: `\`${route.pattern}\` is in the sitemap, though its head says \`noindex\``, help: '`export const page = { noindex: true }` in its server fence sets the tag and leaves it out of the sitemap' })
  }

  return found
}

// The innermost value of each tag wins, as a tag a layout sets is replaced by the page's.
function merge(chain: HeadFacts[]): HeadFacts {
  const merged: HeadFacts = { imageWidth: false, unknownMeta: false }

  for (const facts of chain) {
    merged.title ??= facts.title
    merged.description ??= facts.description
    merged.image ??= facts.image
    merged.robots ??= facts.robots
    merged.imageWidth ||= facts.imageWidth
    merged.unknownMeta ||= facts.unknownMeta
  }

  return merged
}

function headFacts(file: KayFile): HeadFacts {
  const facts: HeadFacts = { imageWidth: false, unknownMeta: false }
  const visit = (nodes: readonly Node[], conditional: boolean) => {
    for (const node of nodes) {
      if (node.kind === 'element' && node.name === 'title' && !node.component)
        facts.title ??= { text: conditional ? undefined : titleText(node), wrapped: !node.attributes.some(entry => entry.kind === 'spread' || file.source.slice(entry.name.start, entry.name.end) === 'raw') }
      else if (node.kind === 'element' && node.name === 'meta' && !node.component)
        readMeta(node, file.source, facts, conditional)

      for (const block of childBlocks(node))
        visit(block, conditional || node.kind !== 'element')
    }
  }

  for (const node of file.template) {
    if (isHead(node))
      visit(node.children, false)
  }

  return facts
}

function titleText(element: ElementNode): string | undefined {
  const chunks: string[] = []

  for (const child of element.children) {
    if (child.kind !== 'text')
      return undefined

    for (const part of child.parts) {
      if (part.kind !== 'chunk')
        return undefined

      chunks.push(part.text)
    }
  }

  const text = decode(chunks.join(' ')).trim()

  return text === '' ? undefined : text
}

function readMeta(element: ElementNode, source: string, facts: HeadFacts, conditional: boolean) {
  const attribute = (name: string) => element.attributes.find(entry => entry.kind !== 'spread' && source.slice(entry.name.start, entry.name.end) === name)
  const valueOf = (name: string): Given | undefined => {
    const found = attribute(name)

    if (found === undefined)
      return undefined

    return { text: found.kind === 'static' && !conditional ? decode(found.text).trim() : undefined }
  }
  const named = attribute('name') ?? attribute('property')

  if (named === undefined || named.kind !== 'static' || element.attributes.some(entry => entry.kind === 'spread')) {
    facts.unknownMeta = true

    return
  }

  const content = valueOf('content')
  const given: Given = { text: content?.text }

  if (named.text === 'description')
    facts.description ??= given
  else if (named.text === 'og:image')
    facts.image ??= given
  else if (named.text === 'og:image:width')
    facts.imageWidth = true
  else if (named.text === 'robots')
    facts.robots ??= given
}
