import { LINTS } from '../src/compiler/lints'

// The exports and members the api snapshot marks `/** @deprecated <text> */`, as the list `api/deprecated.txt` keeps and #2843's upgrade page reads: `deprecations(snapshots)` returns the entries, `bun scripts/api.ts --update` writes the file.
export const DEPRECATED_FILE = 'api/deprecated.txt'

export interface Deprecation {
  package: string
  entry: string
  // The export, or `<export>.<member>` for a prop or a member of one.
  name: string
  text: string
  // The version the text says the form goes with, as `2.0.0` or `1.87`.
  removedIn: string | undefined
  // The `deprecated` group lint that finds the old form, when the text names one.
  lint: string | undefined
  // The text says why no lint finds it: `No lint: <reason>`.
  noLint: string | undefined
}

const MARKER = /^(\s*)\/\*\* @deprecated ?(.*) \*\/(?: (.+))?$/
const HEADER = /^\[(.+?)\] (.+)$/
const REMOVED = /\b(?:removed in|until) (\d+\.\d+(?:\.\d+)?)\b/i
const NO_LINT = /\bno lint: (\S.*)$/i
const CODE = /`([a-z][a-z-]*)`/g
const MEMBER = /^([^\s:?]+)\??:/

// The marker lines of every public snapshot (`api/<package>.txt`, the internal ones too: an app imports them as well), the export a marker ahead of a block's first line belongs to and the member one ahead of a prop does.
export function deprecations(snapshots: Map<string, string>): Deprecation[] {
  const found: Deprecation[] = []

  for (const [path, text] of snapshots) {
    const name = path.split('/').at(-1)!.replace('.txt', '')

    for (const block of text.split('\n\n')) {
      const lines = block.trim().split('\n')
      const header = HEADER.exec(lines[0] ?? '')

      if (header === null)
        continue

      const [, entry, exported] = header as unknown as [string, string, string]

      for (const [index, line] of lines.entries()) {
        const marker = MARKER.exec(line)

        if (marker === null)
          continue

        const [, , note = '', rest = ''] = marker
        // An export's marker is the line right after the header; a member's is the one ahead of its own `name: type`.
        const member = index === 1 ? undefined : MEMBER.exec(rest)?.[1]

        found.push({ package: name, entry, name: member === undefined ? exported : `${exported}.${member}`, text: note, removedIn: REMOVED.exec(note)?.[1], lint: [...note.matchAll(CODE)].map(([, code]) => code!).find(code => code in LINTS), noLint: NO_LINT.exec(note)?.[1] })
      }
    }
  }

  return found
}

// What a deprecation says is wrong with it, nothing when it names the version it goes with and the lint that finds the old form, or why none can.
export function problemsOf(entry: Deprecation): string[] {
  return [
    ...entry.removedIn === undefined ? ['names no removal version: write `Removed in 2.0.0.` or `until 1.90`'] : [],
    ...entry.lint === undefined && entry.noLint === undefined ? ['names no lint: write the `deprecated-...` lint in backticks, or `No lint: <why none can find it>`'] : [],
  ]
}

// One line per deprecation, by package, `<package> [<entry>] <name>`, tab, the removal version, tab, the lint or `-`, tab, the text, so a page by area reads it with a split on tabs.
export function deprecatedList(entries: Deprecation[]): string {
  const lines = entries.map(entry => [`${entry.package} [${entry.entry}] ${entry.name}`, entry.removedIn ?? '?', entry.lint ?? '-', entry.text].join('\t')).sort()

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
