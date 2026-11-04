// How eagerly a link's page is prefetched: `conservative` on press, `moderate` on hover, `eager` as soon as it can, which a page running kay's script reads as the links scrolled into view.
export type Prefetch = 'conservative' | 'moderate' | 'eager' | false

const OFF = '[data-prefetch=false]'
const ON = '[data-prefetch]:not([data-prefetch=false])'
const NESTING = 7

// The chain of `data-prefetch` elements from the root down to a link, alternating off and on, written as a selector: the link itself may be the last of the chain.
function chain(length: number): string {
  const steps = Array.from({ length }, (_, at) => at % 2 === 0 ? OFF : ON)
  const last = steps.pop()!

  return [[...steps, `a${last}`].join(' '), [...steps, last, 'a'].join(' ')].join(', ')
}

// A link follows its nearest `data-prefetch`, itself or an ancestor. CSS cannot ask for the nearest, but the chain of off and on elements above a link, squeezed to alternate, ends on off exactly when its longest subsequence starting on off has an odd length, so the selector lists each odd length that the next one does not reach, up to a nesting of NESTING.
const OPTED_OUT = Array.from({ length: (NESTING + 1) / 2 }, (_, at) => `:is(${chain(at * 2 + 1)}):not(:is(${chain(at * 2 + 2)}))`).join(', ')

// Under a mount point or a moved API, one script per setting, base and API path, made once.
const MOUNTED = new Map<string, string>()
const RULES = new Map<Prefetch, string>((['conservative', 'moderate', 'eager'] as const).map(eagerness => [eagerness, rules(eagerness)]))

// Browsers without speculation rules ignore the script, so a link still loads as usual there.
// Under a mount point, only its own pages are prefetched.
export function speculationRules(prefetch: Prefetch = 'moderate', base = '', apiPath = '/api'): string {
  if ((base === '' && apiPath === '/api') || prefetch === false)
    return RULES.get(prefetch) ?? ''

  const key = `${prefetch}\n${base}\n${apiPath}`
  let script = MOUNTED.get(key)

  if (script === undefined)
    MOUNTED.set(key, script = rules(prefetch, base, apiPath))

  return script
}

// A page running kay's swap prefetches its links itself, reading only how eagerly.
export function prefetchMeta(prefetch: Prefetch = 'moderate'): string {
  return prefetch === false ? '' : `<meta name="kay-prefetch" content="${prefetch}">`
}

// Never kay's own routes or the API, as the page swap leaves them too, nor a download or a link search engines are told not to follow, as a sign-out link often is.
function rules(eagerness: Exclude<Prefetch, false>, base = '', apiPath = '/api'): string {
  const where = { and: [{ href_matches: `${base}/*` }, { not: { href_matches: `${base}/_kay/*` } }, { not: { href_matches: `${base}${apiPath}/*` } }, { not: { href_matches: `${base}${apiPath}` } }, { not: { selector_matches: `[data-no-prefetch], ${OPTED_OUT}, [download], [rel~=nofollow]` } }] }

  return `<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: 'document', where, eagerness }] })}</script>`
}
