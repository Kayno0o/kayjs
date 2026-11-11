import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { peerDependencies } from '../package.json'
import { kayLog } from './runtime/log'

// The optional peers kay loads when a command needs them, never on import, so an app that never runs that command installs none of them. Nothing here imports kay's runtime but `runtime/log`, which imports nothing: the ESLint processor, which runs under Node, reaches this file.
export type Peer = keyof Pick<typeof peerDependencies, 'axe-core' | 'typescript7'>

export const PEERS: Peer[] = ['typescript7', 'axe-core']

// A peer as `bun add` takes it, at the range kay expects.
export function peerSpec(name: Peer): string {
  return `${name}@${peerDependencies[name]}`
}

// What each one is for, as the message names it.
const PURPOSE: Record<Peer, string> = {
  'axe-core': 'the accessibility checks of `kay dev`, `kay a11y` and `page.a11y()`',
  'typescript7': 'the type checks of `kay check`, `kay dev` and the editor server',
}

// The command that installs a peer at the range this kay expects.
export function peerInstallCommand(name: Peer): string {
  return `bun add -d ${peerSpec(name)}`
}

export function missingPeerMessage(name: Peer): string {
  return `${name} is not installed, and kay needs it for ${PURPOSE[name]}: run \`${peerInstallCommand(name)}\``
}

// Named `Error` so the CLI prints its message alone, as it does for a plain error; the commands that print a failure themselves print it on one line.
export class MissingPeerError extends Error {
  override name = 'Error'
}

// Where an optional peer's file is, resolved from `from` (the app that installed it, where kay is a dependency of it); a MissingPeerError naming the install command when it is missing.
export function resolvePeer(name: Peer, specifier: string, from = import.meta.dir): string {
  try {
    return resolveFrom(specifier, from)
  }
  catch {
    throw new MissingPeerError(missingPeerMessage(name))
  }
}

// Bun's resolver, else Node's under the ESLint processor, where `Bun` is not defined and a peer that is there must not read as missing.
function resolveFrom(specifier: string, from: string): string {
  return typeof Bun === 'undefined' ? createRequire(join(from, 'noop.js')).resolve(specifier) : Bun.resolveSync(specifier, from)
}

// Whether the peer resolves from `from`, for a diagnosis that must not throw.
export function peerInstalled(name: Peer, from = import.meta.dir): boolean {
  try {
    resolveFrom(`${name}/package.json`, from)

    return true
  }
  catch {
    return false
  }
}

// The platform package of the native compiler is optional to its own package: missing, the install is broken rather than the peer absent.
export function platformMissingMessage(): string {
  return `the native TypeScript compiler for ${process.platform}-${process.arch} is not installed: run \`bun install\`, or \`${peerInstallCommand('typescript7')}\` again`
}

const noted = new Set<string>()

// Says once, in kay's log, that what kay does with a peer is off because it is missing, for the places that carry on without it; any other error is left to the caller.
export function noteMissingPeer(error: unknown, off: string): void {
  if (!(error instanceof MissingPeerError) || noted.has(off))
    return

  noted.add(off)
  kayLog('warn', `${off} is off: ${error.message}`)
}
