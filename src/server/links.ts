import type { LinkMatcher, LocaleSettings } from '../runtime/i18n'
import { localePath, namesFile, pathSegment, prefixed, segmentsOf } from '../runtime/i18n'

const PATH_END = /[?#]/
const OPTIONAL_MARK = /\?$/
const LINK_MEMO = 2048
const compiledSettings = new WeakMap<LocaleSettings, Compiled>()
// What `encodeURIComponent` leaves as it is, a segment of which is spelled as a URL carries it already.
const PLAIN_SEGMENT = /^[\w.!~*'()-]*$/

// A pattern split once, its static segments spelled as a URL carries them, which no param name or `*` can be; the target is the path it translates to, as written.
interface Candidate {
  segments: string[]
  target: string[]
  order: number
}

// Candidates by the first segment they name outright; the rest, which any path may reach, apart.
interface Indexed {
  byFirst: Map<string, Candidate[]>
  open: Candidate[]
}

interface Compiled {
  pages: Indexed
  entries: Indexed
  links: Map<string, string>
  translations: (locale: string, back: boolean) => Indexed
}

// Everything a settings object's patterns need, split once, as a link meets them on every render; a settings object is read-only from its first link on.
function compiled(settings: LocaleSettings): Compiled {
  let known = compiledSettings.get(settings)

  if (known === undefined) {
    const translated = new Map<string, Indexed>()

    known = {
      pages: indexed((settings.pages ?? []).map((pattern, order) => compile(pattern, '/', order))),
      entries: indexed((settings.entryRoutes ?? []).map((pattern, order) => compile(pattern, '/', order))),
      links: new Map(),
      translations(locale, back) {
        const key = `${locale}${back ? '<' : '>'}`
        let index = translated.get(key)

        if (index === undefined) {
          const candidates: Candidate[] = []

          for (const [pattern, translations] of Object.entries(settings.paths ?? {})) {
            const to = translations[locale]

            if (to !== undefined)
              candidates.push(back ? compile(to, pattern, candidates.length) : compile(pattern, to, candidates.length))
          }

          translated.set(key, index = indexed(candidates))
        }

        return index
      },
    }
    compiledSettings.set(settings, known)
  }

  return known
}

function compile(pattern: string, target: string, order: number): Candidate {
  return { segments: segmentsOf(pattern).map(segment => segment === '*' || segment.startsWith(':') ? segment : pathSegment(segment)), target: segmentsOf(target), order }
}

function indexed(candidates: Candidate[]): Indexed {
  const byFirst = new Map<string, Candidate[]>()
  const open: Candidate[] = []

  for (const entry of candidates) {
    const first = entry.segments[0]

    if (first === undefined || first === '*' || first.startsWith(':')) {
      open.push(entry)

      continue
    }

    const group = byFirst.get(first)

    if (group === undefined)
      byFirst.set(first, [entry])
    else
      group.push(entry)
  }

  return { byFirst, open }
}

// The path's segments spelled as a URL carries them, which is how a pattern's static segments are compared.
function normalized(segments: string[]): string[] {
  return segments.map(segment => PLAIN_SEGMENT.test(segment) ? segment : pathSegment(segment))
}

// The candidate naming most of the path outright, the earliest of equals, with its params gathered; undefined when none takes it.
function bestMatch(index: Indexed, path: string[], spelled: string[]): { candidate: Candidate, named: number, params: Record<string, string> } | undefined {
  let best: { candidate: Candidate, named: number, params: Record<string, string> } | undefined

  for (const group of [index.byFirst.get(spelled[0]!) ?? [], index.open]) {
    for (const candidate of group) {
      const params: Record<string, string> = {}
      const named = matchSegments(candidate.segments, 0, path, spelled, 0, params)

      if (named !== undefined && (best === undefined || named > best.named || (named === best.named && candidate.order < best.candidate.order)))
        best = { candidate, named, params }
    }
  }

  return best
}

// How many segments the pattern names outright when it takes the path from its segment `from` and the path's `at` on, its params gathered; undefined when it does not take it.
function matchSegments(pattern: string[], from: number, path: string[], spelled: string[], at: number, params: Record<string, string>): number | undefined {
  let named = 0
  let place = at

  for (let index = from; index < pattern.length; index++) {
    const head = pattern[index]!

    if (head === '*') {
      params['*'] = path.slice(place).join('/')

      return named
    }

    if (head.startsWith(':') && head.endsWith('?')) {
      // A failed attempt's params must not stay.
      const attempt: Record<string, string> = {}
      const without = matchSegments(pattern, index + 1, path, spelled, place, attempt)

      if (without !== undefined) {
        for (const name in attempt)
          params[name] ??= attempt[name]!

        return named + without
      }
    }

    if (place >= path.length)
      return undefined

    if (!head.startsWith(':')) {
      if (head !== spelled[place])
        return undefined

      named++
    }
    else {
      const name = head.slice(1).replace(OPTIONAL_MARK, '')

      params[name] ??= path[place]!
    }

    place++
  }

  return place === path.length ? named : undefined
}

function resolvedLink(settings: LocaleSettings, href: string, locale: string, currentHost: string | undefined): string {
  const end = href.search(PATH_END)
  const path = end === -1 ? href : href.slice(0, end)
  const segments = segmentsOf(path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path)

  if (!settings.hosts && segments[0] !== undefined && prefixed(settings, segments[0]))
    return href

  if (settings.feeds?.includes(path) === true)
    return localePath({ ...settings, paths: undefined }, href, locale, currentHost)

  const spelled = normalized(segments)
  const { pages, entries } = compiled(settings)
  const file = namesFile(segments.at(-1), () => bestMatch(entries, segments, spelled) !== undefined)
  const named = bestMatch(pages, segments, spelled)?.named

  return named !== undefined && (!file || named === segments.length) ? localePath(settings, href, locale, currentHost) : href
}

// The query and fragment go along; of several patterns taking the path, the one naming most of it outright wins, as the router picks `/blog/new` over `/blog/:slug`.
function repath(settings: LocaleSettings, href: string, locale: string, back: boolean): string {
  if (settings.paths === undefined)
    return href

  const end = href.search(PATH_END)
  const path = end === -1 ? href : href.slice(0, end)
  const slash = path.length > 1 && path.endsWith('/')
  const segments = segmentsOf(slash ? path.slice(0, -1) : path)
  const best = bestMatch(compiled(settings).translations(locale, back), segments, normalized(segments))

  if (best === undefined)
    return href

  const { params } = best
  const { target } = best.candidate

  const filled = target.flatMap((segment) => {
    const param = segment.startsWith(':') ? segment.slice(1).replace(OPTIONAL_MARK, '') : undefined
    const name = segment === '*' ? '*' : param
    const value = name === undefined ? segment : params[name]

    return value === undefined || value === '' ? [] : [value]
  })

  return `/${filled.join('/')}${slash && filled.length > 0 ? '/' : ''}${end === -1 ? '' : href.slice(end)}`
}

// The runtime matches a link against the patterns as they come, which a page of islands does a few times; the server resolves every link of every page, so it keeps each site's patterns split once.
export const compiledLinks: LinkMatcher = {
  link(settings, href, locale, currentHost) {
    const key = `${locale}\n${currentHost ?? ''}\n${href}`
    const known = compiled(settings).links
    let link = known.get(key)

    if (link === undefined) {
      link = resolvedLink(settings, href, locale, currentHost)

      // A link carrying a slug is seen once, so the memo stops growing at a size no site's own links reach.
      if (known.size >= LINK_MEMO)
        known.clear()

      known.set(key, link)
    }

    return link
  },
  repath,
}
