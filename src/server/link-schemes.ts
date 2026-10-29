import type { KayConfig } from '../config'
import { KayError } from '../compiler/errors'
import { NEVER_SCHEMES } from '../runtime/url'

const TRAILING_COLON = /:$/
const SCHEME = /^[a-z][a-z\d+.-]*$/

// The schemes of `links: { schemes }` as a browser spells them, lowercase and with no colon; one that runs script or opens a document of the page's own origin is refused.
export function linkSchemes(config: Pick<KayConfig, 'links'>): string[] {
  const names = config.links?.schemes ?? []

  return names.map((name) => {
    const scheme = typeof name === 'string' ? name.trim().replace(TRAILING_COLON, '').toLowerCase() : ''

    if (!SCHEME.test(scheme))
      throw new KayError('config-invalid', `kay: links.schemes in kay.config.ts has ${JSON.stringify(name)}, which is no URL scheme; list names such as 'webcal' or 'geo'`)

    if (NEVER_SCHEMES.test(scheme))
      throw new KayError('config-invalid', `kay: links.schemes in kay.config.ts lists '${scheme}', which no link may carry: it runs script or opens a document of the page's own origin`)

    return scheme
  })
}
