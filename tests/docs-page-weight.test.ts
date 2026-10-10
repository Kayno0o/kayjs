import type { RenderedPage } from 'kay/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { pageWeight } from '../docs/src/page-weight'

const FILES: Record<string, string> = { '/app.css': 'a { color: red }', '/logo.svg': '<svg></svg>', '/favicon.ico': 'icon'.repeat(500), '/favicon.svg': '<svg viewBox="0 0 32 32"/>', '/entry.js': 'export {}', '/apple-touch-icon.png': 'touch' }
const WEIGHT = /This page: ([\d.]+) KB\./
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kay-page-weight-'))
  await Promise.all(Object.entries(FILES).map(async ([url, text]) => Bun.write(join(dir, url), text)))
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

const brotli = (text: string) => brotliCompressSync(text).length

async function transform(head: string, body = ''): Promise<string> {
  const html = `<html><head><link rel="stylesheet" href="/app.css"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">${head}</head><body>${body}<footer><span data-page-weight></span></footer></body></html>`

  return pageWeight.transformPage!({ path: '/', html, file: async url => url in FILES ? join(dir, url) : undefined })
}

describe('the docs footer\'s page weight', () => {
  it('counts the page and each file a first visit fetches once, as served: text brotli, an icon as it is', async () => {
    const html = await transform('<link rel="modulepreload" href="/entry.js"><script type="module" src="/entry.js"></script>', '<img src="/logo.svg"><img src="/logo.svg"><iframe src="/elsewhere" loading="lazy"></iframe>')
    const linked = brotli(FILES['/app.css']!) + brotli(FILES['/entry.js']!) + brotli(FILES['/logo.svg']!) + FILES['/favicon.ico']!.length

    expect(Number(WEIGHT.exec(html)?.[1])).toBe(Number(((brotli(html) + linked) / 1024).toFixed(1)))
  })

  it('counts the SVG icon alone when the page links one, as a browser drawing it fetches no other', async () => {
    const html = await transform('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    const linked = brotli(FILES['/app.css']!) + brotli(FILES['/favicon.svg']!)

    expect(Number(WEIGHT.exec(html)?.[1])).toBe(Number(((brotli(html) + linked) / 1024).toFixed(1)))
  })

  it('leaves a page without the footer as it is', async () => {
    const page: RenderedPage = { path: '/404', html: '<p>Nothing here</p>', file: async () => undefined }

    expect(await pageWeight.transformPage!(page)).toBe(page.html)
  })
})
