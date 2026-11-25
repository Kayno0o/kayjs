// Regression tests for #3553: missing ImageMagick and bun-plugin-tailwind warn once at startup,
// fail `kay check`, and images always report real dimensions or fail the build.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { images, optimizeImageFile, readImageDimensions } from '@kayjs/images'
import { tailwind } from '@kayjs/tailwind'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { createServer } from '../src/server/index'

const IMAGES_MOD = resolve(import.meta.dir, '../../plugin-images/src/index.ts')
const TAILWIND_MOD = resolve(import.meta.dir, '../../plugin-tailwind/src/index.ts')

// Minimal valid 2x3 PNG (1-bit grayscale, uncompressed deflate)
const PNG_2X3 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000020000000308020000004d2111600000000c49444154789c63606060000000040001f61738550000000049454e44ae426082',
  'hex',
)

// Minimal valid 4x5 GIF89a header
const GIF_4X5 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x04, 0x00, 0x05, 0x00])

// Minimal JPEG SOF0 marker with 640x480
const JPEG_640X480 = new Uint8Array([
  0xFF, 0xD8,
  0xFF, 0xC0, 0x00, 0x0B, 0x08,
  0x01, 0xE0, // height = 480
  0x02, 0x80, // width = 640
  0x01, 0x01, 0x11, 0x00,
  0xFF, 0xD9,
])

// Minimal WebP VP8X header with 300x200 (stored as w-1, h-1 in 24-bit LE)
const WEBP_300X200 = new Uint8Array(30)
new DataView(WEBP_300X200.buffer).setUint32(0, 0x52494646) // RIFF
new DataView(WEBP_300X200.buffer).setUint32(8, 0x57454250) // WEBP
new DataView(WEBP_300X200.buffer).setUint32(12, 0x56503858) // VP8X
WEBP_300X200[24] = 299 & 0xFF
WEBP_300X200[25] = (299 >> 8) & 0xFF
WEBP_300X200[27] = 199 & 0xFF
WEBP_300X200[28] = (199 >> 8) & 0xFF

describe('#3553 plugin tooling checks & real image dimensions', () => {
  test('readImageDimensions parses PNG, GIF, JPEG, and WebP headers accurately', () => {
    expect(readImageDimensions(PNG_2X3)).toEqual({ width: 2, height: 3 })
    expect(readImageDimensions(GIF_4X5)).toEqual({ width: 4, height: 5 })
    expect(readImageDimensions(JPEG_640X480)).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(WEBP_300X200)).toEqual({ width: 300, height: 200 })
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
  })

  test('@kayjs/images without magick warns once at startup, fails kay check, and reports real dimensions (never 0x0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3553-img-'))
    const prevPath = process.env.PATH
    const warnings: string[] = []
    const origWarn = console.warn
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/assets'), { recursive: true })
      writeFileSync(join(dir, 'src/assets/pixel.png'), PNG_2X3)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import pixel from '../assets/pixel.png'
export default function Home() {
  return <img src={pixel.src} width={pixel.width} height={pixel.height} alt="p" />
}
`)
      writeFileSync(join(dir, 'kay.config.ts'), `
import { images } from ${JSON.stringify(IMAGES_MOD)}
export default { plugins: [images()] }
`)

      process.env.PATH = ''
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

      const plugin = images()
      await build({ root: dir, plugins: [plugin] })
      // Warned once across client + server bunPlugins passes
      expect(warnings.filter(w => w.includes('ImageMagick')).length).toBe(1)

      const app = await createServer({ root: dir, plugins: [plugin] })
      const html = await (await app.handle(new Request('http://localhost/'))).text()
      expect(html).toContain('width="2"')
      expect(html).toContain('height="3"')

      const check = await checkProject(dir, { skipTypecheck: true })
      expect(check.ok).toBe(false)
      expect(check.errors.some(e => e.includes('ImageMagick'))).toBe(true)

      // Direct optimizeImageFile also reports real dimensions without magick
      const opt = optimizeImageFile(join(dir, 'src/assets/pixel.png'), { outPublicDir: join(dir, 'out-pub') })
      expect(opt.width).toBe(2)
      expect(opt.height).toBe(3)
    }
    finally {
      process.env.PATH = prevPath
      console.warn = origWarn
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('@kayjs/images fails the build instead of exporting 0x0 for unreadable image bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3553-corrupt-'))
    const prevPath = process.env.PATH
    const origWarn = console.warn
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/assets'), { recursive: true })
      writeFileSync(join(dir, 'src/assets/broken.png'), 'not-a-real-png-file')
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import broken from '../assets/broken.png'
export default function Home() {
  return <img src={broken.src} width={broken.width} height={broken.height} alt="bad" />
}
`)

      process.env.PATH = ''
      console.warn = () => {}
      let caught: unknown
      try {
        await build({ root: dir, plugins: [images()] })
      }
      catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      const details = [
        caught instanceof Error ? caught.message : String(caught),
        ...((caught as { errors?: { message?: string }[] })?.errors?.map(e => e.message ?? '') ?? []),
      ].join('\n')
      expect(details).toMatch(/could not determine dimensions/i)

      expect(() => optimizeImageFile(join(dir, 'src/assets/broken.png'), { outPublicDir: join(dir, 'out-pub') }))
        .toThrow(/could not determine dimensions/i)
    }
    finally {
      process.env.PATH = prevPath
      console.warn = origWarn
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('@kayjs/tailwind without bun-plugin-tailwind warns once at startup and fails kay check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3553-tw-'))
    const warnings: string[] = []
    const origWarn = console.warn
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/app.css'), 'body { margin: 0; }\n')
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>tw</p> }\n')
      writeFileSync(join(dir, 'kay.config.ts'), `
import { tailwind } from ${JSON.stringify(TAILWIND_MOD)}
export default { plugins: [tailwind()] }
`)

      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

      const plugin = tailwind()
      await build({ root: dir, plugins: [plugin] })
      expect(warnings.filter(w => w.includes('bun-plugin-tailwind')).length).toBe(1)

      const check = await checkProject(dir, { skipTypecheck: true })
      expect(check.ok).toBe(false)
      expect(check.errors.some(e => e.includes('bun-plugin-tailwind'))).toBe(true)
    }
    finally {
      console.warn = origWarn
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
