import type { LocaleSettings } from './i18n'
import { localizeLinks } from './dom'
import { localizedLink } from './i18n'
import { pageData } from './page-data'

// Defined by a build for a site with `i18n`, which alone has links to localize.
declare const KAY_I18N: true | undefined

// What a link needs of the scripts the server writes for a page's islands: the page's locale and the site's settings, which the first one carries.
interface LinkPayload {
  locale?: string
  settings?: LocaleSettings
}

const PAYLOAD = 'script[data-kay-i18n]'
let settings: LocaleSettings | undefined
let pageLocale = ''
// Whether a read ran once the page was parsed: the settings are known from then on, a swap to another locale loading the page afresh.
let settled = false

// Takes what a script carries for links, from the read of `kay/i18n` too, so the page is searched once for both.
export function noteLinkPayload(payload: LinkPayload): void {
  settings ??= payload.settings
  pageLocale ||= payload.locale ?? ''
}

// A link an island sets, in the page's locale as the server writes it; see `localizedLink`.
export function localizedHref(href: string): string {
  if (!settings && !settled) {
    settled = document.readyState !== 'loading'

    for (const payload of pageData<LinkPayload>(PAYLOAD))
      noteLinkPayload(payload)
  }

  return settings ? localizedLink(settings, href, pageLocale, location.host) : href
}

// Imported by the islands writing a link and by `kay/i18n`, so a page whose islands do neither ships none of it.
if (typeof KAY_I18N !== 'undefined')
  localizeLinks(localizedHref)
