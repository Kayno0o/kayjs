// The origin and mount point `site` and `base` in kay.config.ts give, set as the server boots or the build prerenders, and whether its URLs end with a slash: one site per process.
let configured: { origin: string, slashed: boolean } | undefined

export function setSite(origin: string | undefined, trailingSlash?: 'never' | 'always' | 'ignore'): void {
  configured = origin === undefined ? undefined : { origin, slashed: trailingSlash === 'always' }
}

export function configuredSite(): { origin: string, slashed: boolean } | undefined {
  return configured
}
