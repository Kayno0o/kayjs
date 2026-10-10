// A page of a list kay's `paginate()` split, which links each page itself.
export interface PagedList {
  page: number
  pages: number
  href: (page: number) => string
}

// A page left out between two shown, drawn as an ellipsis.
export type PageGap = 'gap'

// The page a request asked for as one that exists: a whole number from 1 to `pages`, the first for anything else, such as `?page=abc`.
export function currentPage(page: number, pages: number): number {
  const whole = Math.trunc(page)

  return Number.isFinite(whole) ? Math.min(Math.max(whole, 1), Math.max(pages, 1)) : 1
}

// The pages a pagination links: the first, the last, and `siblings` on each side of the current one, a gap where pages are left out. A gap would hide one page only, so that page shows instead.
export function pageItems(page: number, pages: number, siblings = 1): (number | PageGap)[] {
  const shown = new Set([1, pages])

  for (let near = page - siblings; near <= page + siblings; near++) {
    if (near >= 1 && near <= pages)
      shown.add(near)
  }

  const sorted = [...shown].sort((a, b) => a - b)
  const items: (number | PageGap)[] = []

  for (const [index, item] of sorted.entries()) {
    const before = sorted[index - 1]

    if (before !== undefined && item - before === 2)
      items.push(before + 1)
    else if (before !== undefined && item - before > 2)
      items.push('gap')

    items.push(item)
  }

  return items
}

// The link to a page: the current URL's path and query with `param` set to it, left out for the first page so it keeps one URL.
export function pageHref(url: URL | string, page: number, param = 'page'): string {
  const target = new URL(url, 'http://localhost')

  if (page <= 1)
    target.searchParams.delete(param)
  else
    target.searchParams.set(param, String(page))

  return `${target.pathname}${target.search}`
}
