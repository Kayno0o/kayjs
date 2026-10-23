import { describe, expect, it } from 'bun:test'
import { hubRepository, pinnedImages, refreshed } from '../scripts/image-digests'

const A = `sha256:${'a'.repeat(64)}`
const B = `sha256:${'b'.repeat(64)}`
const SOURCE = `// Base images
const POSTGRES_IMAGE = 'postgres:18-alpine@${A}'
const NGINX_IMAGE = 'nginxinc/nginx-unprivileged:1.31-alpine@${B}'
const NOT_PINNED = 'oven/bun:1.4.4'
const TOO_SHORT = 'debian:bookworm-slim@sha256:abc'
`

describe('image digests script', () => {
  it('reads each image pinned by tag and digest, and nothing else', () => {
    expect(pinnedImages(SOURCE)).toEqual([
      { constant: 'POSTGRES_IMAGE', repository: 'postgres', tag: '18-alpine', digest: A },
      { constant: 'NGINX_IMAGE', repository: 'nginxinc/nginx-unprivileged', tag: '1.31-alpine', digest: B },
    ])
  })

  it('reads the three images of src/templates.ts', async () => {
    const images = pinnedImages(await Bun.file(`${import.meta.dir}/../src/templates.ts`).text())

    expect(images.map(image => image.constant)).toEqual(['POSTGRES_IMAGE', 'RUNTIME_IMAGE', 'NGINX_IMAGE'])
  })

  it('names an official image under library/ and leaves another alone', () => {
    expect(hubRepository('postgres')).toBe('library/postgres')
    expect(hubRepository('nginxinc/nginx-unprivileged')).toBe('nginxinc/nginx-unprivileged')
  })

  it('prints the line a refresh puts in place', () => {
    const [postgres] = pinnedImages(SOURCE)

    expect(refreshed(postgres!, B)).toBe(`const POSTGRES_IMAGE = 'postgres:18-alpine@${B}'`)
  })
})
