// Service keys shared between two plugins, kept in core as contracts so neither plugin depends on the other.

export interface ActiveI18nConfig {
  readonly locales: readonly string[]
  readonly defaultLocale: string
  readonly prefixDefault: boolean
}

export const I18N_CONFIG_SERVICE = 'kay.i18n.config'

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

export const CONTENT_IMAGE_RESOLVER_SERVICE = 'kay.content.imageResolver'
