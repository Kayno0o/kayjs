// What a page module tells kay, the keys of its `export const page`.
export const PAGE_SETTINGS = ['prerender', 'revalidate', 'layouts', 'query', 'sitemap', 'noindex'] as const
export type PageSettingName = typeof PAGE_SETTINGS[number]
export const PAGE = 'page'
