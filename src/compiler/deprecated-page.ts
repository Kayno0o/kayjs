import type { Diagnostic, Span } from './ast'
import type { ServerAnalysis } from './script'
import { SEO_SETTINGS } from './page-settings'

const SPACE = /\s/
const within = (inner: Span, outer: Span) => inner.start >= outer.start && inner.end <= outer.end

// The range a setting leaves when it is taken out of `page` after the first one moved: the entry and the comma after it, its whole line when it stands alone on one, so a comment above it stays where it is. The last entry with no comma takes the comma before it, when nothing but space lies between.
function removal(source: string, key: Span, value: Span): { start: number, end: number } {
  let end = value.end

  while (SPACE.test(source[end] ?? ''))
    end++

  if (source[end] === ',') {
    end++

    let start = key.start

    while (source[start - 1] === ' ' || source[start - 1] === '\t')
      start--

    let after = end

    while (source[after] === ' ' || source[after] === '\t')
      after++

    if ((start === 0 || source[start - 1] === '\n') && source[after] === '\n')
      return { start, end: after + 1 }

    return { start: key.start, end: after }
  }

  let start = key.start

  while (SPACE.test(source[start - 1] ?? '') && start > 0)
    start--

  return { start: source[start - 1] === ',' ? start - 1 : key.start, end: value.end }
}

// The ranges with those that overlap joined, as a last entry's comma before it may be the one the entry above took with it.
function merged(source: string, ranges: { start: number, end: number }[]): { start: number, end: number }[] {
  const joined: { start: number, end: number }[] = []

  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = joined.at(-1)

    if (last && range.start < last.end)
      last.end = Math.max(last.end, range.end)
    else
      joined.push({ ...range })
  }

  // A last entry written with no comma leaves the comma before the ones taken out behind, which goes with them.
  for (const range of joined) {
    let after = range.end
    let before = range.start

    while (source[after] === ' ' || source[after] === '\t')
      after++

    while (SPACE.test(source[before - 1] ?? ''))
      before--

    if (source[after] === '}' && source[range.end - 1] !== ',' && source[range.end - 1] !== '\n' && source[before - 1] === ',')
      range.start = before - 1
  }

  return joined
}

// What a page wrote before 1.105 for its head, its sitemap entry and its cache: `noindex`, `sitemap`, `lastmod`, `search` and `feed` are the `seo` group, `ttl` and `cacheControl` are `cache`.
// The fix runs only where the new form is a plain rewrite of the old one, which is where `seo` or `cache` is not already there.
export function deprecatedPageSettings(source: string, server: ServerAnalysis | undefined): Diagnostic[] {
  const settings = server?.page?.settings

  if (!settings)
    return []

  const seo = settings.get('seo')
  const text = (span: Span) => source.slice(span.start, span.end)
  // The settings read from inside `seo` are in the map by their own names too.
  const moved = SEO_SETTINGS.flatMap(name => settings.has(name) && !(seo && within(settings.get(name)!.key, seo.value)) ? [{ name, ...settings.get(name)! }] : []).toSorted((a, b) => a.key.start - b.key.start)
  const found: Diagnostic[] = []

  if (moved.length > 0) {
    const [first, ...rest] = moved
    const inner = moved.map(setting => `${setting.name}: ${text(setting.value)}`).join(', ')
    const fix = seo ? undefined : { title: 'Move them into `seo`', safe: true, edits: [{ start: first!.key.start, end: first!.value.end, text: `seo: { ${inner} }` }, ...merged(source, rest.map(setting => removal(source, setting.key, setting.value))).map(range => ({ ...range, text: '' }))] }

    for (const setting of moved) {
      found.push({
        ...setting.key,
        code: 'deprecated-page-seo',
        checkOnly: true,
        message: `\`${setting.name}\` is a setting of \`seo\` since 1.105: the group holds what search engines and the sitemap read of the page`,
        help: seo ? `move it into the \`seo\` the page has: \`seo: { ${setting.name}: ... }\`` : `write \`page = { seo: { ${setting.name}: ... } }\``,
        fixes: fix ? [fix] : [],
      })
    }
  }

  const ttl = settings.get('ttl')
  const control = settings.get('cacheControl')
  const alone = !settings.has('cache') && (ttl === undefined) !== (control === undefined) ? (ttl ?? control)! : undefined
  // `cacheControl` as `false` is `cache: false`; any other text is a header, which `cache: { browser, shared, swr }` builds from its parts.
  const plain = alone !== undefined && (alone === ttl || text(alone.value).trim() === 'false')

  for (const [name, setting] of [['ttl', ttl], ['cacheControl', control]] as const) {
    if (setting === undefined)
      continue

    found.push({
      ...setting.key,
      code: 'deprecated-page-cache',
      checkOnly: true,
      message: `\`${name}\` is \`cache\` since 1.105, which sets the lifetime and the \`cache-control\` of the page in one place`,
      help: plain && alone === setting ? 'write `cache: \'1h\'`, `cache: false` for the default header' : 'write `cache: \'1h\'` or `cache: { browser, shared, swr }`, `cache: \'private\'` or `cache: false`',
      fixes: plain && alone === setting ? [{ title: 'Write `cache`', safe: true, edits: [{ start: setting.key.start, end: setting.key.end, text: 'cache' }] }] : [],
    })
  }

  return found
}
