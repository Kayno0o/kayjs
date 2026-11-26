// Service keys: `serviceKey` for any plugin, and the keys shared between two plugins, kept in core as contracts so neither depends on the other.

declare const SERVICE_TYPE: unique symbol

/** Names a service and the type of its value; `provide` and `inject` take one instead of a string. */
export interface ServiceKey<T> {
  readonly name: string
  readonly [SERVICE_TYPE]?: T
}

export function serviceKey<T>(name: string): ServiceKey<T> {
  return { name }
}

export interface ActiveI18nConfig {
  readonly locales: readonly string[]
  readonly defaultLocale: string
  readonly prefixDefault: boolean
}

export const I18N_CONFIG_SERVICE = serviceKey<ActiveI18nConfig>('kay.i18n.config')

export interface ContentImageResult {
  src: string
  srcset?: string | undefined
  avifSrcset?: string | undefined
  sizes?: string | undefined
  width?: number | undefined
  height?: number | undefined
  loading?: 'lazy' | 'eager' | undefined
}

export type ContentImageResolver = (src: string, file: string | undefined) => ContentImageResult | string | undefined

export const CONTENT_IMAGE_RESOLVER_SERVICE = serviceKey<ContentImageResolver>('kay.content.imageResolver')
