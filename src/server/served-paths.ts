import { routerKey } from './routes'

// What serves a path: a page, a public file, an endpoint, a redirect, an API module's route, or kay itself.
export type ClaimKind = 'page' | 'public' | 'endpoint' | 'redirect' | 'api' | 'kay'

export interface Claim {
  // As the router reads it: `:name` params, a final `*`.
  path: string
  // Named in the error when another claims the path: a file, or what kay serves there.
  owner: string
  kind: ClaimKind
  // GET when left out; `ALL` takes every method.
  method?: string | undefined
  // The locale whose host serves it, when locales go by domain.
  scope?: string | undefined
  // The paths a static export writes it to: its own, or those it lists once asked.
  exported?: true | (() => Promise<string[]>) | undefined
  // A page checking a param with a matcher, which passes what it refuses to the next page at its path.
  fallsThrough?: boolean | undefined
  // A page under the path i18n.paths gives it in a locale.
  translated?: boolean | undefined
  // An endpoint's extension after its last param, `.json` for `[slug].json.ts`.
  suffix?: string | undefined
}

// Words the error for a claim on a path another holds.
export type Clash = (taken: Claim) => string

// Pages share a path when all but one check a matcher, untranslated; endpoints share one when each takes its own extension; API modules' routes are Elysia's to tell apart.
function mayShare(claim: Claim, taken: Claim): boolean {
  if (claim.kind !== taken.kind)
    return false

  if (claim.kind === 'page')
    return claim.translated !== true && taken.translated !== true && (claim.fallsThrough === true || taken.fallsThrough === true)

  return claim.kind === 'api' || (claim.kind === 'endpoint' && claim.suffix !== taken.suffix)
}

function overlap(claim: Claim, taken: Claim): boolean {
  const method = claim.method ?? 'GET'
  const other = taken.method ?? 'GET'

  return (method === other || method === 'ALL' || other === 'ALL') && (claim.scope === undefined || taken.scope === undefined || claim.scope === taken.scope)
}

// Every path the server serves, claimed as each feature registers its routes, so two that would serve one path stop the boot; what is only offered, kay's own files, an HTML file's path without `.html` and a translated page's untranslated path, gives way to any claim.
export class ServedPaths {
  readonly #claims = new Map<string, Claim[]>()
  readonly #offers = new WeakSet<Claim>()

  // The claims holding the path already, which this one cannot share it with.
  #holders(claim: Claim): Claim[] {
    return this.#claims.get(routerKey(claim.path))?.filter(taken => overlap(claim, taken) && !mayShare(claim, taken)) ?? []
  }

  #add(claim: Claim): void {
    const key = routerKey(claim.path)

    this.#claims.set(key, [...this.#claims.get(key) ?? [], claim])
  }

  // Takes the path from what only offered it, or stops the boot with what `clash` says of the claim holding it.
  claim(claim: Claim, clash?: Clash): void {
    const holders = this.#holders(claim)
    const taken = holders.find(holder => !this.#offers.has(holder))

    if (taken)
      throw new Error(clash?.(taken) ?? `kay: ${taken.owner} and ${claim.owner} both serve ${claim.path}`)

    if (holders.length > 0)
      this.#claims.set(routerKey(claim.path), this.#claims.get(routerKey(claim.path))!.filter(held => !holders.includes(held)))

    this.#add(claim)
  }

  // Takes the path unless something serves it already, and says whether it did; a later claim takes it back.
  offer(claim: Claim): boolean {
    if (this.#holders(claim).length > 0)
      return false

    this.#offers.add(claim)
    this.#add(claim)

    return true
  }

  // Whether the claim still holds its path, for a feature to serve it only then.
  holds(claim: Claim): boolean {
    return this.#claims.get(routerKey(claim.path))?.includes(claim) === true
  }

  // The GET paths a static export writes, in the order they were claimed.
  async exported(): Promise<string[]> {
    const paths: string[] = []

    for (const claims of this.#claims.values()) {
      for (const { path, exported } of claims) {
        if (exported === true)
          paths.push(path)
        else if (exported)
          paths.push(...await exported())
      }
    }

    return paths
  }
}
