import { safeUrl } from './url'

// The characters a browser drops from a URL, and the scheme before the first colon.
const SKIPPED = /^[\0-\x20]+|[\t\n\r]/g
let reporter: ((attribute: string, url: string, scheme: string) => void) | undefined

// Told of each bound URL rewritten to `unsafe:`, which `kay dev` logs.
export function onUnsafeUrl(report: typeof reporter): void {
  reporter = report
}

// `safeUrl` for the server's renderers, which tell the reporter of a URL it rewrote; kept out of `url.ts` so an island's bundle carries none of it.
export function reportedUrl(name: string, value: string): string {
  const safe = safeUrl(name, value)

  if (reporter && safe !== value) {
    const url = value.replace(SKIPPED, '')

    reporter(name.toLowerCase(), url, url.slice(0, url.indexOf(':')).toLowerCase())
  }

  return safe
}
