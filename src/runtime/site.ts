// The origin and mount point `site` and `base` in kay.config.ts give, set as the server boots or the build prerenders, and whether its URLs end with a slash: one site per process.
let configured: { origin: string, slashed: boolean } | undefined
// While `kay build` prerenders with no site, a page reading it renders against a stand-in, counted so the server renders that page again once it runs for a site.
let standIn: { reads: number } | undefined

const STAND_IN = { origin: 'http://localhost', slashed: false }

export function setSite(origin: string | undefined, trailingSlash?: 'never' | 'always' | 'ignore', prerendering = false): void {
  configured = origin === undefined ? undefined : { origin, slashed: trailingSlash === 'always' }
  standIn = origin === undefined && prerendering ? { reads: 0 } : undefined
}

export function configuredSite(): { origin: string, slashed: boolean } | undefined {
  return configured
}

// The site a page renders against: the configured one, or a build's stand-in.
export function renderedSite(): { origin: string, slashed: boolean } | undefined {
  if (configured || !standIn)
    return configured

  standIn.reads++

  return STAND_IN
}

export function standInReads(): number {
  return standIn?.reads ?? 0
}
