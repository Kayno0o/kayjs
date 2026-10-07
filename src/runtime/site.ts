// The origin and mount point `site` and `base` in kay.config.ts give, set as the server boots.
let configured: string | undefined

export function setSite(origin: string | undefined): void {
  configured = origin
}

export function configuredSite(): string | undefined {
  return configured
}
