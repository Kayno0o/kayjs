const CSP_SPACE = /\s+/
// The verdicts kept for the first policies seen: a site sends one per page settings, and past these, as when a nonce makes each one new, a policy is judged again each time.
const KEPT_POLICIES = 64
const KEPT_POLICY_LENGTH = 8192
const policyVerdicts = new Map<string, boolean>()

// Whether a response's own policy refuses every fetch, `connect-src` or its fallback `default-src` being `'none'`: the browser could not load a dictionary the page named, and logs a violation for the attempt. Several policies on one header all apply, so one refusing is enough.
export function forbidsFetch(policy: string | null): boolean {
  if (policy === null)
    return false

  let verdict = policyVerdicts.get(policy)

  if (verdict === undefined) {
    verdict = refusesFetch(policy)

    if (policy.length <= KEPT_POLICY_LENGTH && policyVerdicts.size < KEPT_POLICIES)
      policyVerdicts.set(policy, verdict)
  }

  return verdict
}

function refusesFetch(policy: string): boolean {
  return policy.split(',').some((one) => {
    const directives = new Map<string, string>()

    for (const directive of one.split(';')) {
      const [name = '', ...sources] = directive.trim().split(CSP_SPACE).filter(word => word !== '')

      if (name !== '' && !directives.has(name.toLowerCase()))
        directives.set(name.toLowerCase(), sources.join(' ').toLowerCase())
    }

    const sources = directives.get('connect-src') ?? directives.get('default-src')

    // An empty source list is the same as `'none'`.
    return sources === '\'none\'' || sources === ''
  })
}
