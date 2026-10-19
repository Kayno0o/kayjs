import { kayLog } from '../runtime/log'

const HSTS = 'strict-transport-security'
// A header name as HTTP spells it, each dash-separated word capitalised.
const WORDS = /(^|-)([a-z])/g
const LINE_BREAK = /[\r\n]/

function titled(name: string): string {
  return name.replace(WORDS, (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`)
}

// The headers as a `_headers` file, which Netlify and Cloudflare Pages read, every path getting them.
export function headersFile(headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([name, value]) => `  ${titled(name)}: ${value}`)

  return `/*\n${lines.join('\n')}\n`
}

// The headers as `add_header` lines for an nginx `include`, repeated by the config in every location with an `add_header` of its own, as nginx drops the inherited ones there.
// HSTS is left out, as the scaffold's nginx.conf sends it itself and a header added twice is sent twice; a value nginx cannot spell, one with a `$` it would expand or a line break, is left out with a warning.
export function nginxHeaders(headers: Record<string, string>): string {
  const lines: string[] = []

  for (const [name, value] of Object.entries(headers)) {
    if (name === HSTS)
      continue

    if (value.includes('$') || LINE_BREAK.test(value)) {
      kayLog('warn', `the ${titled(name)} header holds a $ or a line break, which an nginx add_header cannot send as it is: it is left out of headers.nginx.conf`)

      continue
    }

    lines.push(`add_header ${titled(name)} "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" always;`)
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '# kay sends no security headers for this build.\n'
}
