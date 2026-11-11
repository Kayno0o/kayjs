import { join } from 'node:path'
import process from 'node:process'
import { findUp } from '@kaynooo/cli-kit'
import { PEERS, peerSpec } from '../peers'

// Installs the peers the app lacks as dev dependencies, at kay's ranges: `kay upgrade` has it run for an app coming from a kay that held them as its own dependencies. Answers whether the app has them all afterwards; `install` runs the command in the app's folder and answers its exit code.
export async function addMissingPeers(root: string, install: (command: string[], cwd: string) => Promise<number> = runInstall): Promise<boolean> {
  const missing = PEERS.filter(name => findUp(join('node_modules', name, 'package.json'), root) === undefined)

  if (missing.length === 0)
    return true

  console.error(`kay upgrade: adding ${missing.join(' and ')} to devDependencies, which kay no longer installs itself`)

  return await install([process.execPath, 'add', '--dev', ...missing.map(peerSpec)], root) === 0
}

async function runInstall(command: string[], cwd: string): Promise<number> {
  return Bun.spawn(command, { cwd, stdin: 'ignore', stdout: process.stderr.fd, stderr: 'inherit' }).exited
}
