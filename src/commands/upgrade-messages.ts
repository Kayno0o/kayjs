import type { Phase } from './upgrade'

// Says each package a dry run would move in `phase`, and that its kay still rewrites forms when the phase is a stop on the way.
export function wouldMove({ version, changes, stone }: Phase, say: (verb: string, rest: string) => void): void {
  for (const { name, spec } of changes)
    say('would move', `${name} to ${spec.slice(spec.lastIndexOf('~'))}${stone ? ` (kay ${version} still rewrites forms the next minors drop)` : ''}`)
}

// Why a phase's install failed and where that left the app: back as it was when nothing had been rewritten, else at the version `behind` that the rewrites reached.
export function installFailed(version: string, behind: string, from: string): string {
  const left = behind === from
    ? 'so package.json and the lockfile are back as they were and nothing was rewritten; node_modules may still hold what the install did'
    : `after the forms of the minors up to ${behind} were rewritten on the way; package.json and the lockfile are back at kay ${behind}`

  return `the install of kay ${version} failed or left no kay in node_modules, ${left}, so run \`bun install\` once the install is fixed, then \`kay upgrade\` again`
}
