// What the platform does for plain page changes with no kay JS: cross-document view transitions, Speculation Rules and a marked panel's scroll offset kept across page loads.

import { escJson } from './index'

export const KEEP_SCROLL_ATTR = 'data-kay-keep-scroll'
export const NO_PREFETCH_ATTR = 'data-kay-no-prefetch'

export type Eagerness = 'conservative' | 'moderate' | 'eager'

export interface NavigationConfig {
  /** Fades one page into the next with a cross-document view transition (`@view-transition { navigation: auto }`), off under `prefers-reduced-motion`. On by default, `false` leaves the browser's plain repaint. */
  viewTransitions?: boolean | undefined
  /** When the browser fetches the page a same-origin link points at, through Speculation Rules: `'moderate'` (the default) on hover, `'conservative'` on press, `'eager'` as soon as it can, `false` never. A link, or an ancestor of it, with `data-kay-no-prefetch` is never fetched; neither is a `download` or `rel="nofollow"` link, a kay route (actions among them) or another origin's page. */
  prefetch?: Eagerness | false | undefined
  /** Renders the page a link points at before it is followed, which runs its `load()`: off by default, `true` is `'moderate'`. */
  prerender?: Eagerness | boolean | undefined
}

/** The head markup shared by every page and the CSP sources that allow it. */
export interface Navigation {
  html: string
  styleHashes: readonly string[]
  scriptHashes: readonly string[]
}

export const VIEW_TRANSITION_STYLE = '@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}'

// Runs at the end of the body, with the marked panels parsed and before the first paint of a page sent whole. An offset is kept per history entry (an id in `history.state`, which back, forward and reload keep) when the page is left, and a new entry starts from the offsets of the page its link came from, a same-origin referrer showing that. Storage that throws leaves the page as it loaded.
export const KEEP_SCROLL_SCRIPT = `{try{const A="${KEEP_SCROLL_ATTR}",S=sessionStorage,s=history.state,o=s&&typeof s=="object"?s:{},own=o.kayScroll,id=own||Math.random().toString(36).slice(2),read=k=>JSON.parse(S.getItem(k)||"{}"),saved=own?read("kay-scroll:"+id):document.referrer.startsWith(location.origin+"/")?read("kay-scroll"):{};own||history.replaceState({...o,kayScroll:id},"");for(const e of document.querySelectorAll("["+A+"]"))saved[e.getAttribute(A)]>0&&(e.scrollTop=saved[e.getAttribute(A)]);addEventListener("pagehide",()=>{try{const m={};for(const e of document.querySelectorAll("["+A+"]"))m[e.getAttribute(A)]=e.scrollTop;const j=JSON.stringify(m);S.setItem("kay-scroll:"+id,j);S.setItem("kay-scroll",j)}catch{}})}catch{}}`
export const KEEP_SCROLL_TAG = `<script>${KEEP_SCROLL_SCRIPT}</script>`

function sha256(text: string): string {
  return `'sha256-${new Bun.CryptoHasher('sha256').update(text).digest('base64')}'`
}

const EAGERNESS = new Set<unknown>(['conservative', 'moderate', 'eager'])

/** Throws on a `navigation` setting the browser would ignore without a word. */
export function checkNavigationConfig(config: NavigationConfig | undefined): void {
  if (config === undefined)
    return
  for (const key of ['prefetch', 'prerender'] as const) {
    const value: unknown = config[key]
    const allowed = value === undefined || value === false || EAGERNESS.has(value) || (key === 'prerender' && value === true)
    if (!allowed)
      throw new Error(`kay: navigation.${key} is ${JSON.stringify(value)} in kay.config.ts: use 'conservative', 'moderate', 'eager'${key === 'prefetch' ? ' or false' : ', true or false'}.`)
  }
}

// Never a link that opts out (or sits in a container that does), a download, a nofollow link (a sign-out link often is), kay's own routes (an action's URL among them); `href_matches: '/*'` only reaches this origin.
function rulesWhere(): object {
  return { and: [{ href_matches: '/*' }, { not: { href_matches: '/_kay/*' } }, { not: { selector_matches: `[${NO_PREFETCH_ATTR}], [${NO_PREFETCH_ATTR}] a, [download], [rel~=nofollow]` } }] }
}

/** What a page's head holds for the `navigation` settings, made once at start: the rules for each setting left on, as one style and one script the policy hashes. */
export function createNavigation(config: NavigationConfig | undefined): Navigation {
  checkNavigationConfig(config)
  const styleHashes: string[] = []
  const scriptHashes = [sha256(KEEP_SCROLL_SCRIPT)]
  let html = ''
  if (config?.viewTransitions !== false) {
    html += `<style>${VIEW_TRANSITION_STYLE}</style>`
    styleHashes.push(sha256(VIEW_TRANSITION_STYLE))
  }
  const prefetch = config?.prefetch === undefined ? 'moderate' : config.prefetch
  const prerender = config?.prerender === true ? 'moderate' : config?.prerender || undefined
  if (prefetch !== false || prerender !== undefined) {
    const where = rulesWhere()
    const rules: Record<string, unknown[]> = {}
    if (prefetch !== false)
      rules.prefetch = [{ source: 'document', where, eagerness: prefetch }]
    if (prerender !== undefined)
      rules.prerender = [{ source: 'document', where, eagerness: prerender }]
    const json = escJson(JSON.stringify(rules))
    html += `<script type="speculationrules">${json}</script>`
    scriptHashes.push(sha256(json))
  }
  return { html, styleHashes, scriptHashes }
}

const DUPLICATE_RE = new RegExp(` ${KEEP_SCROLL_ATTR}="([^"]*)"`, 'g')

/** The script a document needs for the panels it marks, or nothing: a page leaving `data-kay-keep-scroll` out costs one `includes`. Two panels of one key throw, as the browser could keep only one offset for them. */
export function keepScrollTag(body: string): string {
  if (!body.includes(` ${KEEP_SCROLL_ATTR}`))
    return ''
  const seen = new Set<string>()
  for (const [, key] of body.matchAll(DUPLICATE_RE)) {
    if (seen.has(key!))
      throw new Error(`kay: ${KEEP_SCROLL_ATTR}="${key}" is on two elements of one page: give each panel its own key.`)
    seen.add(key!)
  }
  return KEEP_SCROLL_TAG
}
