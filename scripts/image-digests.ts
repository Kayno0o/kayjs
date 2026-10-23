import { join, resolve } from 'node:path'
import process from 'node:process'

// Checks that each base image `kay new` pins by digest in src/templates.ts still resolves for its tag through the registry API, and prints the refresh for one that moved: `bun scripts/image-digests.ts`.
// A moved digest is not a failure of the pin, which keeps building the bytes reviewed; it only means the tag now has newer ones, with the fixes of its base. It reads the registry and changes nothing.
const TEMPLATES = join(resolve(import.meta.dir, '..'), 'src/templates.ts')
const PINNED = /^const (\w+_IMAGE) = '([^'@:]+):([^'@]+)@(sha256:[0-9a-f]{64})'$/gm
const REGISTRY = 'https://registry-1.docker.io'
const AUTH = 'https://auth.docker.io/token?service=registry.docker.io'
const MANIFEST_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ')
const TIMEOUT_MS = 15_000

export interface PinnedImage {
  constant: string
  repository: string
  tag: string
  digest: string
}

// The images pinned as `const NAME_IMAGE = 'repository:tag@sha256:...'`.
export function pinnedImages(source: string): PinnedImage[] {
  return [...source.matchAll(PINNED)].map(match => ({ constant: match[1]!, repository: match[2]!, tag: match[3]!, digest: match[4]! }))
}

// The repository as Docker Hub names it: an official image lives under `library/`.
export function hubRepository(repository: string): string {
  return repository.includes('/') ? repository : `library/${repository}`
}

// The line of src/templates.ts after the digest of an image moved to `digest`.
export function refreshed(image: PinnedImage, digest: string): string {
  return `const ${image.constant} = '${image.repository}:${image.tag}@${digest}'`
}

async function resolveDigest(image: PinnedImage): Promise<string> {
  const repository = hubRepository(image.repository)
  const auth = await fetch(`${AUTH}&scope=repository:${repository}:pull`, { signal: AbortSignal.timeout(TIMEOUT_MS) })

  if (!auth.ok)
    throw new Error(`the registry token answered ${auth.status}`)

  const { token } = await auth.json() as { token: string }
  const manifest = await fetch(`${REGISTRY}/v2/${repository}/manifests/${image.tag}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const digest = manifest.headers.get('docker-content-digest')

  if (!manifest.ok || digest === null)
    throw new Error(`the manifest of ${image.repository}:${image.tag} answered ${manifest.status}`)

  return digest
}

async function main(): Promise<number> {
  const images = pinnedImages(await Bun.file(TEMPLATES).text())

  if (images.length === 0) {
    console.error('no pinned image found in src/templates.ts')

    return 1
  }

  let failed = false

  for (const image of images) {
    try {
      const digest = await resolveDigest(image)

      if (digest === image.digest) {
        console.log(`ok     ${image.repository}:${image.tag}`)

        continue
      }

      failed = true
      console.log(`moved  ${image.repository}:${image.tag}\n  pinned ${image.digest}\n  now    ${digest}\n  replace the ${image.constant} line of src/templates.ts with:\n  ${refreshed(image, digest)}`)
    }
    catch (error) {
      failed = true
      console.log(`failed ${image.repository}:${image.tag}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failed)
    console.log('\nAfter a refresh, run `bun test tests/new.test.ts`: it checks the generated files carry a digest.')

  return failed ? 1 : 0
}

if (import.meta.main)
  process.exit(await main())
