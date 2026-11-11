import { kayLog } from '../runtime/log'

const HSTS = 'strict-transport-security'
// A header name as HTTP spells it, each dash-separated word capitalised.
const WORDS = /(^|-)([a-z])/g
const LINE_BREAK = /[\r\n]/
const PATTERN = /[*:\s]/
const TRAILING_SLASH = /\/+$/
const HEADER_LINE = /^[ \t]+([\w-]+):/
const INDENTED = /^[ \t]/

function titled(name: string): string {
  return name.replace(WORDS, (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`)
}

// The headers as a `_headers` file, which Netlify and Cloudflare Pages read, every path getting them, and then each page that answers a `cache-control` of its own at its path, with and without the trailing slash.
// A path holding a `*` or a `:` is a pattern to those hosts, so it is left out.
export function headersFile(headers: Record<string, string> | undefined, caches: ReadonlyMap<string, string> = new Map()): string {
  const lines = Object.entries(headers ?? {}).filter(([, value]) => !LINE_BREAK.test(value)).map(([name, value]) => `  ${titled(name)}: ${value}`)
  const blocks = lines.length > 0 ? [`/*\n${lines.join('\n')}\n`] : []

  for (const [path, control] of caches) {
    if (PATTERN.test(path) || LINE_BREAK.test(control))
      continue

    for (const rule of path === '/' ? ['/'] : [path.replace(TRAILING_SLASH, ''), `${path.replace(TRAILING_SLASH, '')}/`])
      blocks.push(`${rule}\n  Cache-Control: ${control}\n`)
  }

  return blocks.join('\n')
}

// The headers the app's own `_headers` text does not name for every path (its `/*` rule), so kay's block can follow it and a header the app set there wins; one it names under another path alone stays, as it does not reach the rest of the site.
export function unnamedHeaders(headers: Record<string, string>, mine: string): Record<string, string> {
  const named = new Set<string>()
  let everywhere = false

  for (const line of mine.split('\n')) {
    const header = HEADER_LINE.exec(line)

    if (header !== null)
      everywhere && named.add(header[1]!.toLowerCase())
    else if (line.trim() !== '' && !INDENTED.test(line))
      everywhere = line.trim() === '/*'
  }

  return Object.fromEntries(Object.entries(headers).filter(([name]) => !named.has(name.toLowerCase())))
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
