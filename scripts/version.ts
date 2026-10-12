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
const parts = current.split('.').map((part, index) => index < level ? Number(part) : index === level ? Number(part) + 1 : 0)
const version = parts.join('.')
// Any patch of the minor, so an app a patch behind the libraries meets their peer.
const peer = `~${parts[0]}.${parts[1]}.0`
const libraries = await Array.fromAsync(new Glob('packages/*/package.json').scan())
const manifests = ['package.json', ...libraries]

for (const path of manifests) {
  const text = await Bun.file(path).text()

  if (!VERSION.test(text) || (path !== 'package.json' && !KAY_PEER.test(text)))
    throw new Error(`${path} has no version or no peer on kay to move`)

  await Bun.write(path, text.replace(VERSION, () => `"version": "${version}"`).replace(KAY_PEER, (_, head: string) => `${head}"${peer}"`))
}

// bun.lock records each workspace's version and ranges, which the CI's frozen install compares against.
try {
  await $`bun install`.quiet()
}
catch (error) {
  await $`git checkout -- bun.lock ${manifests}`

  throw error
}

await $`git add bun.lock ${manifests}`
await $`git commit -q -m ${`v${version}`}`
await $`git tag ${`v${version}`}`

console.log(`v${version}`)
