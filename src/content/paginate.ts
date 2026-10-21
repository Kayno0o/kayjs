import type { LocaleSettings } from '../runtime/i18n'
import type { Component } from '../runtime/jsx'
import type { Collection, Entry } from './index'
import { KayError } from '../compiler/errors'
import { localize } from '../runtime/i18n.server'
import { localeState, runInLocale } from '../runtime/locale-state'
import { configuredSite } from '../runtime/site'

export const PAGINATED = Symbol.for('kay.paginated')
const PAGE_NUMBER = /^[1-9]\d*$/

// One page of a list: its items, where it stands, and the links to the others, in the request's locale.
export interface Page<Item> {
  items: Item[]
  // From 1.
  page: number
  pages: number
  // The page before and the one after, undefined at the ends.
  prev: string | undefined
  next: string | undefined
  // The link to any page, the first at the list's own path.
  href: (page: number) => string
}

export interface Paginated<Item> {
  readonly [PAGINATED]: true
  readonly pageSize: number
  /** @deprecated The old name of `pageSize`, kept three minors. */
  readonly size: number
  // The page a route's optional param asks for, `ctx.params.page`: undefined when it is no page of the list, `1` included, which is the list's own path.
  page: (param: string | number | undefined) => Promise<Page<Item> | undefined>
  // How many pages each locale has, or the one count without locales: what `prerender` and the sitemap list.
  pageCounts: (settings?: LocaleSettings) => Promise<Map<string | undefined, number>>
}

type Items<Item> = readonly Item[] | (() => readonly Item[] | Promise<readonly Item[]>)

// Splits a collection, a list or a function returning one into pages of `size` items, for a page such as `blog/[[page=integer]].kay`; exported as `prerender`, it lists every page.
export function paginate<Data>(source: Collection<Data, Record<string, Component<never>>, string>, size: number): Paginated<Entry<Data>>
export function paginate<Item>(source: Items<Item>, size: number): Paginated<Item>
export function paginate<Item>(source: Collection<unknown, Record<string, Component<never>>, string> | Items<Item>, size: number): Paginated<Item> {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new KayError('pagination-misuse', `kay: paginate takes a whole number of items per page, from 1, not ${size}`)

  const read = async (): Promise<readonly Item[]> => {
    if (typeof source === 'function')
      return source()

    return 'all' in source ? await source.all() as unknown as Item[] : source
  }
  const count = (items: readonly unknown[]) => Math.max(1, Math.ceil(items.length / size))

  return {
    [PAGINATED]: true,
    pageSize: size,
    size,
    page: async (param) => {
      const number = pageNumber(param)

      if (!Number.isSafeInteger(number) || number < 1 || (param !== undefined && number === 1))
        return undefined

      const items = await read()
      const pages = count(items)

      if (number > pages)
        return undefined

      const list = listPath(param !== undefined)
      const href = (page: number) => sitePath(page === 1 ? list : `${list === '/' ? '' : list}/${page}`)

      return { items: items.slice((number - 1) * size, number * size), page: number, pages, prev: number > 1 ? href(number - 1) : undefined, next: number < pages ? href(number + 1) : undefined, href }
    },
    pageCounts: async (settings) => {
      if (!settings)
        return new Map([[undefined, count(await read())]])

      const counts = new Map<string | undefined, number>()

      // Each locale counts the entries it lists, the default locale's standing in for those it lacks.
      for (const locale of settings.locales)
        counts.set(locale, count(await runInLocale({ locale, messages: new Map(), settings, path: '/' }, read)))

      return counts
    },
  }
}

export function isPaginated(value: unknown): value is Paginated<unknown> {
  return typeof value === 'object' && value !== null && PAGINATED in value
}

function pageNumber(param: string | number | undefined): number {
  if (param === undefined)
    return 1

  if (typeof param === 'number')
    return param

  return PAGE_NUMBER.test(param) ? Number(param) : Number.NaN
}

// The path of the page being rendered, untranslated and without its locale's prefix, its page segment left out.
function listPath(numbered: boolean): string {
  const state = localeState()

  if (!state)
    throw new KayError('pagination-misuse', 'kay: a paginated list reads the page it renders, so page() runs while a page does')

  const path = state.path.length > 1 && state.path.endsWith('/') ? state.path.slice(0, -1) : state.path

  return numbered ? path.slice(0, path.lastIndexOf('/')) || '/' : path
}

// A path of the site in the request's locale, ending with a slash when the site's URLs do.
function sitePath(path: string): string {
  const localized = localize(path)

  return configuredSite()?.slashed === true && !localized.endsWith('/') ? `${localized}/` : localized
}
