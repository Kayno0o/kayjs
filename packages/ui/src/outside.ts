// The attributes of a link opening another site in a new tab, shared by every link kayjs-ui draws that does. `data-new-tab` is the mark kay's page rule reads to say so to screen readers.
export const OUTSIDE = { 'target': '_blank', 'rel': 'noopener noreferrer', 'data-new-tab': '' } as const

// Whether a link opens in a new tab: `true` always, `false` never, `'auto'` when the address leaves the site.
export type NewTab = boolean | 'auto'

const OTHER_SITE = /^(?:https?:)?\/\//

// Whether a link leaves the site: an absolute (`https://...`) or protocol-relative (`//host`) address, read the same on the server and in the browser so hydration agrees. The test every component with link entries uses for its `newTab: 'auto'`.
export function isExternal(href: string): boolean {
  return OTHER_SITE.test(href)
}

// The attributes of a link given its `newTab` choice, `'auto'` when left out.
export function tabOf(href: string | undefined, newTab: NewTab | undefined = 'auto'): typeof OUTSIDE | Record<never, never> {
  if (newTab === 'auto')
    return href !== undefined && isExternal(href) ? OUTSIDE : {}

  return newTab ? OUTSIDE : {}
}
