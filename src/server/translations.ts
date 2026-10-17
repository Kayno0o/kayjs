// What a site's locales lack against its default one, for a command translating them.
import type { KayConfig } from '../config'
import type { Message } from '../runtime/i18n'
import { missingMessages } from '../check/messages'
import { localizedSlugs } from '../content/server'

// What a locale lacks against the default locale: the keys of its messages, with the default locale's message for each, and the slugs each localized collection has in the default locale and not in it.
export interface MissingTranslations {
  messages: Record<string, Message>
  entries: Record<string, string[]>
}

// What each locale but the default lacks, the extensions' catalogs read as the server reads them; nothing for a site without `i18n`.
export async function missingTranslations(root: string, config: Pick<KayConfig, 'i18n' | 'extensions' | 'content'>): Promise<Record<string, MissingTranslations>> {
  const { i18n } = config

  if (!i18n)
    return {}

  const [messages, slugs] = await Promise.all([missingMessages(root, i18n, config.extensions), localizedSlugs(root, config.content)])
  const missing: Record<string, MissingTranslations> = {}

  for (const locale of i18n.locales.filter(code => code !== i18n.defaultLocale)) {
    const entries = [...slugs].map(([name, byLocale]) => [name, [...byLocale.get(i18n.defaultLocale) ?? []].filter(slug => !byLocale.get(locale)?.has(slug))] as const)

    missing[locale] = { messages: Object.fromEntries(messages.get(locale) ?? []), entries: Object.fromEntries(entries.filter(([, lacked]) => lacked.length > 0)) }
  }

  return missing
}
