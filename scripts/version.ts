#!/usr/bin/env bun
// Bumps every package under packages/*/package.json (plus peerDependencies.kay,
// packages/kay/src/cli/new.ts default version, bun.lock and docs/bun.lock) in lockstep,
// then commits and creates annotated tag v<next>.
// Usage: bun scripts/version.ts <alpha|beta|rc|patch|minor|major|X.Y.Z[-pre]> [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs'
import { Glob } from 'bun'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const level = args.find(a => !a.startsWith('-'))

if (!level) {
  console.error('Usage: bun scripts/version.ts <alpha|beta|rc|patch|minor|major|version> [--dry-run]')
  process.exit(1)
}

function nextVersion(current: string, target: string): string {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target))
    return target

  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/)
  if (!match)
    throw new Error(`Unsupported current version: ${current}`)

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const preTag = match[4]
  const preNum = match[5] !== undefined ? Number(match[5]) : -1

  if (target === 'alpha' || target === 'beta' || target === 'rc') {
    if (preTag === target)
      return `${major}.${minor}.${patch}-${target}.${preNum + 1}`
    if (preTag !== undefined)
      return `${major}.${minor}.${patch}-${target}.0`
    return `${major}.${minor}.${patch + 1}-${target}.0`
  }

  if (target === 'patch')
    return preTag !== undefined ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
  if (target === 'minor')
    return `${major}.${minor + 1}.0`
  if (target === 'major')
    return `${major + 1}.0.0`

  throw new Error(`Unknown release level: ${target}`)
}

const corePkgPath = 'packages/kay/package.json'
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8')) as { version: string }
const next = nextVersion(corePkg.version, level)
const tag = `v${next}`

if (dryRun) {
  console.log(`${corePkg.version} -> ${next} (${tag})`)
  process.exit(0)
}

const manifests: string[] = []
for await (const p of new Glob('packages/*/package.json').scan('.'))
  manifests.push(p)
manifests.sort()

for (const p of manifests) {
  const pkg = JSON.parse(readFileSync(p, 'utf8')) as {
    version: string
    peerDependencies?: Record<string, string>
  }
  pkg.version = next
  if (pkg.peerDependencies) {
    if ('@kayjs/kay' in pkg.peerDependencies)
      pkg.peerDependencies['@kayjs/kay'] = `^${next}`
    if ('kay' in pkg.peerDependencies)
      pkg.peerDependencies.kay = `^${next}`
  }
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
}

const newCliPath = 'packages/kay/src/cli/new.ts'
const newCli = readFileSync(newCliPath, 'utf8')
const updatedNewCli = newCli.replace(
  /const kayVersion = options\.kayVersion \?\? '\^[^']+'/,
  `const kayVersion = options.kayVersion ?? '^${next}'`,
)
if (updatedNewCli === newCli)
  throw new Error(`Failed to update default kayVersion in ${newCliPath}`)
writeFileSync(newCliPath, updatedNewCli)

const run = (cmd: string[]) => {
  const proc = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0)
    process.exit(proc.exitCode || 1)
}

run(['bun', 'install', '--silent'])
run(['bun', 'install', '--silent', '--cwd', 'docs'])
run(['git', 'add', ...manifests, newCliPath, 'bun.lock', 'docs/bun.lock'])
run(['git', 'commit', '-m', `chore(release): ${tag}`])
run(['git', 'tag', '-a', tag, '-m', `Kay ${tag}`])

console.log(tag)
