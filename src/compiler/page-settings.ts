// What a page module tells kay, the keys of its `export const page`.
export const PAGE_SETTINGS = ['prerender', 'ttl', 'cacheControl', 'layouts', 'query', 'sitemap', 'noindex', 'keep'] as const
export type PageSettingName = typeof PAGE_SETTINGS[number]
export const PAGE = 'page'
// The settings that moved from `page` into its `seo` group in 1.105.
export const SEO_SETTINGS: readonly string[] = ['noindex', 'sitemap', 'lastmod', 'search', 'feed']

// The report for a key `page` held before 1.105 and no longer reads, which fails the build naming where it is written now.
export function movedSettingReport(key: string): { message: string, help: string } | undefined {
  if (SEO_SETTINGS.includes(key))
    return { message: `\`${key}\` is a setting of \`seo\`, not of \`page\`, since 1.105`, help: `write \`page = { seo: { ${key}: ... } }\`` }

  if (key === 'ttl' || key === 'cacheControl')
    return { message: `\`${key}\` is \`cache\` since 1.105, which sets the lifetime and the \`cache-control\` of the page in one place`, help: 'write `cache: \'1h\'`, `cache: { browser, shared, swr }`, `cache: \'private\'` or `cache: false`' }

  return undefined
}

// The report for a `guards` or `layouts` setting the server cannot read, shared by the compiler and `kay check` so both say it alike.
export function unreadSettingReport(key: string): { message: string, help: string } {
  return {
    message: `kay reads \`${key}\` as a literal \`true\` or \`false\``,
    help: `write \`${key}: false\` itself: the server reads it from the source, so a variable or an expression is ignored`,
  }
}
