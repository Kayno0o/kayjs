// How eagerly Chromium prefetches a link's page: `conservative` on press, `moderate` on hover, `eager` as soon as it can.
export type Prefetch = 'conservative' | 'moderate' | 'eager' | false

// Under a mount point, one script per setting and base, made once.
const MOUNTED = new Map<string, string>()
const RULES = new Map<Prefetch, string>((['conservative', 'moderate', 'eager'] as const).map(eagerness => [eagerness, rules(eagerness)]))

// Browsers without speculation rules ignore the script, so a link still loads as usual there.
// Under a mount point, only its own pages are prefetched.
export function speculationRules(prefetch: Prefetch = 'moderate', base = ''): string {
  if (base === '' || prefetch === false)
    return RULES.get(prefetch) ?? ''

  const key = `${prefetch}\n${base}`
  let script = MOUNTED.get(key)

  if (script === undefined)
    MOUNTED.set(key, script = rules(prefetch, base))

  return script
}

// Never kay's own routes or the API, as the page swap leaves them too, nor a download or a link search engines are told not to follow, as a sign-out link often is.
function rules(eagerness: Exclude<Prefetch, false>, base = ''): string {
  const where = { and: [{ href_matches: `${base}/*` }, { not: { href_matches: `${base}/_kay/*` } }, { not: { href_matches: `${base}/api/*` } }, { not: { href_matches: `${base}/api` } }, { not: { selector_matches: '[data-no-prefetch], [download], [rel~=nofollow]' } }] }

  return `<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: 'document', where, eagerness }] })}</script>`
}
