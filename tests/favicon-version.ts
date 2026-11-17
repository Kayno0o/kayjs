import { faviconSource, faviconVersion } from '../src/server/favicon'

// The `?v=` version the icon links of a site with no `favicon` carry: that of kay's own mark.
export const MARK_VERSION = (await faviconVersion(faviconSource('.', undefined)!))!
