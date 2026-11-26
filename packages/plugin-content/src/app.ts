// The app a collection renders for. Collections are read from route modules, not through the plugin, so each read asks kay which app the current request or build belongs to.

import type { ContentImageResolver } from '@kayjs/kay/config'
import { CONTENT_IMAGE_RESOLVER_SERVICE, I18N_CONFIG_SERVICE } from '@kayjs/kay/config'
import { getAppContext } from '@kayjs/kay/internal/server'

export const currentApp = {
  root: (): string | undefined => getAppContext()?.root,
  site: (): string | undefined => getAppContext()?.site,
  dev: (): boolean | undefined => getAppContext()?.dev,
  defaultLocale: (): string | undefined => getAppContext()?.inject(I18N_CONFIG_SERVICE)?.defaultLocale,
  imageResolver: (): ContentImageResolver | undefined => getAppContext()?.inject(CONTENT_IMAGE_RESOLVER_SERVICE),
}
