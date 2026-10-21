// What a page module tells kay, the keys of its `export const page`.
export const PAGE_SETTINGS = ['prerender', 'revalidate', 'layouts', 'query', 'sitemap', 'noindex', 'keep'] as const
export type PageSettingName = typeof PAGE_SETTINGS[number]
export const PAGE = 'page'

// The report for a `guards` or `layouts` setting the server cannot read, shared by the compiler and `kay check` so both say it alike.
export function unreadSettingReport(key: string): { message: string, help: string } {
  return {
    message: `kay reads \`${key}\` as a literal \`true\` or \`false\``,
    help: `write \`${key}: false\` itself: the server reads it from the source, so a variable or an expression is ignored`,
  }
}
