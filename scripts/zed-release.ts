// The Zed extension is released with kay: its version and the tag of the grammar it builds are those of the release commit.
const VERSION = /^version = "[^"]+"/
const REV = /^rev = "[^"]+"/
const TABLE = /^\s*\[/
const GRAMMAR_TABLE = /^\s*\[grammars\.kay\]\s*(?:#.*)?$/

export const ZED_MANIFEST = 'editors/zed/extension.toml'

// Rewrites the first `version` line before any table and the first `rev` line inside [grammars.kay], and reports whether both exist.
function scoped(manifest: string, version: string): { found: boolean, text: string } {
  let table = ''
  let versionDone = false
  let revDone = false
  const lines = manifest.split('\n').map((line) => {
    if (TABLE.test(line))
      table = GRAMMAR_TABLE.test(line) ? 'grammar' : 'other'

    if (table === '' && !versionDone && VERSION.test(line)) {
      versionDone = true

      return line.replace(VERSION, `version = "${version}"`)
    }

    if (table === 'grammar' && !revDone && REV.test(line)) {
      revDone = true

      return line.replace(REV, `rev = "v${version}"`)
    }

    return line
  })

  return { found: versionDone && revDone, text: lines.join('\n') }
}

export function zedReleasable(manifest: string): boolean {
  return scoped(manifest, '0.0.0').found
}

export function zedRelease(manifest: string, version: string): string {
  return scoped(manifest, version).text
}
