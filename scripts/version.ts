import process from 'node:process'
import { $, Glob } from 'bun'

// `bun scripts/version.ts patch|minor|major`: kay and every library under packages/ move to one version, committed as `v<version>` and tagged, as `bun pm version` does for one package.
const LEVELS = ['major', 'minor', 'patch'] as const
const VERSION = /"version": "[^"]+"/
// A library's peer on kay, which names kay by its alias where `workspace:` can only name a workspace by its own name.
const KAY_PEER = /("peerDependencies": \{[^}]*"kay": )"[^"]+"/

const level = LEVELS.indexOf(process.argv[2] as typeof LEVELS[number])

if (level === -1)
  throw new Error(`usage: bun scripts/version.ts ${LEVELS.join('|')}`)

if ((await $`git status --porcelain`.text()).trim() !== '')
  throw new Error('the working tree has changes: commit them first')

const current = ((await Bun.file('package.json').json()) as { version: string }).version
const version = current.split('.').map((part, index) => index < level ? part : index === level ? Number(part) + 1 : 0).join('.')
const manifests = ['package.json', ...await Array.fromAsync(new Glob('packages/*/package.json').scan())]

for (const path of manifests) {
  const text = await Bun.file(path).text()

  await Bun.write(path, text.replace(VERSION, () => `"version": "${version}"`).replace(KAY_PEER, (_, head: string) => `${head}"~${version}"`))
}

// bun.lock records each workspace's version and ranges, which the CI's frozen install compares against.
await $`bun install`.quiet()
await $`git add bun.lock ${manifests}`
await $`git commit -q -m ${`v${version}`}`
await $`git tag ${`v${version}`}`

console.log(`v${version}`)
