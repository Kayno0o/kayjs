import type { Diagnostic, Span } from './ast'
import type { ServerAnalysis } from './script'

// The settings of `page` that moved into `seo` in 1.105.
const SEO_KEYS = ['noindex', 'sitemap', 'lastmod', 'search', 'feed']

const within = (inner: Span, outer: Span) => inner.start >= outer.start && inner.end <= outer.end

// The range a setting leaves when it is taken out of `page`: its line when it has one to itself, else the entry and its comma.
function removal(source: string, key: Span, value: Span): { start: number, end: number } {
  let end = value.end

  while (source[end] === ' ' || source[end] === '\t')
    end++

  const last = source[end] !== ','

  if (!last) {
    end++

    while (source[end] === ' ' || source[end] === '\t')
      end++
  }
  else {
    end = value.end
  }

  let start = key.start

  while (source[start - 1] === ' ' || source[start - 1] === '\t')
    start--

  if ((start === 0 || source[start - 1] === '\n') && source[end] === '\n')
    return { start, end: end + 1 }

  // The last entry takes the comma before it along, the one after it being none.
  return { start: last ? start - (source[start - 1] === ',' ? 1 : 0) : key.start, end }
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
  const moved = SEO_KEYS.flatMap(name => settings.has(name) && !(seo && within(settings.get(name)!.key, seo.value)) ? [{ name, ...settings.get(name)! }] : [])
  const found: Diagnostic[] = []

  if (moved.length > 0) {
    const [first, ...rest] = moved
    const inner = moved.map(setting => `${setting.name}: ${text(setting.value)}`).join(', ')
    const fix = seo ? undefined : { title: 'Move them into `seo`', safe: true, edits: [{ start: first!.key.start, end: first!.value.end, text: `seo: { ${inner} }` }, ...rest.map(setting => ({ ...removal(source, setting.key, setting.value), text: '' }))] }

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
