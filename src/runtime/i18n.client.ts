import type { Direction, Locale, LocaleSettings, Localize, Message, MessageValue, RelativeTimeOptions, RichText, Translate } from './i18n'
import { withBase, withoutBase } from './base'
import { fragment, insert, localizeLinks, markers } from './dom'
import { formatDate as formatDateIn, formatList as formatListIn, formatNumber as formatNumberIn, formatRelativeTime as formatRelativeTimeIn, localePath, localizedLink, richMessage, splitLocale, textDirection, translate, untranslatedPath } from './i18n'
import { pageData } from './page-data'
import { createSignal, effect, memo, onCleanup, onMount } from './reactive'

export type { Direction, Locale, LocaleSettings, MergeMessages, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory, RelativeTimeOptions, RichText } from './i18n'
export { defineMessages } from './i18n'

// What the server writes for a page's islands, one script per part of a streamed page: the locale, and the messages its islands use.
interface Payload {
  locale?: string
  settings?: LocaleSettings
  messages: Record<string, Message>
  // When the server rendered the page, for `relativeTime`.
  now?: number
}

const PAYLOAD = 'script[data-kay-i18n]'
const read = new WeakSet<Payload>()
const messages = new Map<string, Message>()
let settings: LocaleSettings | undefined
let pageLocale = ''
let renderedAt: number | undefined
// Whether a read ran once the page was parsed: the locale and settings are known from then on, a swap to another locale loading the page afresh, so only a missing message reads again.
let settled = false

// Reads the scripts not read yet, so messages a streamed part brought are found too.
function load(): void {
  settled = document.readyState !== 'loading'

  for (const payload of pageData<Payload>(PAYLOAD)) {
    if (read.has(payload))
      continue

    read.add(payload)
    settings ??= payload.settings
    pageLocale ||= payload.locale ?? ''
    renderedAt ??= payload.now

    for (const [key, message] of Object.entries(payload.messages))
      messages.set(key, message)
  }
}

function translations() {
  if (!settled)
    load()

  return { locale: pageLocale || document.documentElement.lang, messages }
}

export const t = ((key: string, params?: Record<string, MessageValue>) => {
  if (!messages.has(key))
    load()

  return translate(translations(), key, params)
}) as Translate

// Rendered again when a placeholder it fills changes.
export const T = ((props: { key: string }) => fragment((parent) => {
  const [start, end] = markers(parent)

  insert(null, start, end, () => {
    if (!messages.has(props.key))
      load()

    return richMessage(translations(), props.key, props)
  })
})) as RichText

// A link an island sets, in the page's locale as the server writes it; see `localizedLink`.
export function localizedHref(href: string): string {
  if (!settings && !settled)
    load()

  return settings ? localizedLink(settings, href, pageLocale, location.host) : href
}

localizeLinks(localizedHref)

export function locale(): Locale {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
  return translations().locale as Locale
}

export const localize = ((href: string, target?: string) => {
  const { locale: current } = translations()

  return withBase(settings ? localePath(settings, href, target ?? current, location.host) : href)
}) as Localize

export function alternate(target: Locale): string {
  const { locale: current } = translations()
  const path = withoutBase(location.pathname)

  if (!settings)
    return withBase(path)

  // The page's own path first, which its locale may translate.
  const { locale, path: own } = splitLocale(settings, path)

  return withBase(localePath(settings, untranslatedPath(settings, own, locale ?? current), target, location.host))
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(translations().locale, value, options)
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatDateIn(translations().locale, value, options)
}

export function formatRelativeTime(value: Date | number, options?: RelativeTimeOptions): string
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
export function formatRelativeTime(value: Date | number, unitOrOptions?: Intl.RelativeTimeFormatUnit | RelativeTimeOptions, options?: Intl.RelativeTimeFormatOptions): string {
  return formatRelativeTimeIn(translations().locale, value, unitOrOptions, options)
}

// A date relative to now, formatted as `formatRelativeTime` does, that goes on ticking while the island lives: every second under a minute away, every minute under an hour, every hour past that.
// It renders first as relative to the page's render time, as the server did, so hydrating changes nothing.
export function relativeTime(value: () => Date | number, options?: Intl.RelativeTimeFormatOptions): () => string {
  load()

  const [now, setNow] = createSignal(renderedAt ?? Date.now())
  const pace = memo(() => tickPace(Math.abs(Number(value()) - now()) / 1000))

  onMount(() => setNow(Date.now()))
  effect(() => {
    const timer = setInterval(() => setNow(Date.now()), pace())

    onCleanup(() => clearInterval(timer))
  })

  return memo(() => formatRelativeTime(value(), { ...options, now: now() }))
}

function tickPace(seconds: number): number {
  return seconds < 60 ? 1000 : seconds < 3600 ? 60_000 : 3_600_000
}

export function formatList(items: Iterable<string>, options?: Intl.ListFormatOptions): string {
  return formatListIn(translations().locale, items, options)
}

// Which way a locale's script runs, the request's or any one given, for what lays itself out by hand: `rtl` or `ltr`.
export function direction(of?: string): Direction {
  return textDirection(of ?? translations().locale)
}
