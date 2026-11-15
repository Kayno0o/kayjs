// The attributes of a link opening another site in a new tab, shared by every link kayjs-ui draws that does. `data-new-tab` is the mark kay's page rule reads to say so to screen readers.
export const OUTSIDE = { 'target': '_blank', 'rel': 'noopener noreferrer', 'data-new-tab': '' } as const

// Whether a link opens in a new tab: `true` always, `false` never, `'auto'` when the address leaves the site.
export type NewTab = boolean | 'auto'

const OTHER_SITE = /^(?:https?:)?\/\//

// Whether a link leaves the site: any absolute http(s) (`https://...`) or protocol-relative (`//host`) address counts, the site's own origin included, as the server and the browser must read it the same for hydration to agree. The test every component with link entries uses for its `newTab: 'auto'`.
export function isExternal(href: string): boolean {
  return OTHER_SITE.test(href)
}

// A link kept in this tab by an explicit `newTab={false}`: it writes a `target` of its own, which leaves the page's `links.outside` rule no say, as it leaves any link writing one.
const SAME_TAB = { target: undefined } as const

type TabAttributes = Partial<typeof OUTSIDE> | typeof SAME_TAB

// The attributes of a link given its `newTab` choice, `'auto'` when left out: an explicit `false` is the last word, so the link stays in this tab even where the app's `links.outside` would open it in a new one.
export function tabOf(href: string | undefined, newTab: NewTab | undefined = 'auto'): TabAttributes {
  if (newTab === 'auto')
    return href !== undefined && isExternal(href) ? OUTSIDE : {}

  return newTab ? OUTSIDE : SAME_TAB
}
