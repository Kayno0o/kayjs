// Regression tests for #3553: missing ImageMagick and bun-plugin-tailwind warn once at startup,
// fail `kay check`, and images always report real dimensions or fail the build.

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// A JPEG header as a phone writes it: SOI, an optional JFIF APP0, an Exif APP1 holding only Orientation, then SOF0 at 640x480.
function jpegWithOrientation(orientation: number, { endian = 'MM', jfif = false, truncated = false, xmp = false }: { endian?: 'MM' | 'II', jfif?: boolean, truncated?: boolean, xmp?: boolean } = {}): Uint8Array {
  const u16 = (n: number) => endian === 'MM' ? [n >> 8, n & 0xFF] : [n & 0xFF, n >> 8]
  const u32 = (n: number) => endian === 'MM' ? [0, 0, ...u16(n)] : [...u16(n), 0, 0]
  const tiff = [...Buffer.from(endian), ...u16(0x2A), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)]
  const body = [...Buffer.from('Exif\0\0'), ...(truncated ? tiff.slice(0, 10) : tiff)]
  const xmpBody = [...Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')]
  return new Uint8Array([
    0xFF, 0xD8,
    ...(jfif ? [0xFF, 0xE0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0] : []),
    0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body,
    ...(xmp ? [0xFF, 0xE1, (xmpBody.length + 2) >> 8, (xmpBody.length + 2) & 0xFF, ...xmpBody] : []),
    ...JPEG_640X480.slice(2),
  ])
}

describe('@kayjs/images sizes a photo as it is displayed, after its EXIF orientation (#3676)', () => {
  test('swaps width and height for orientations 5 to 8, in either byte order and after a JFIF segment', () => {
    expect(readImageDimensions(jpegWithOrientation(6))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(8))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(5))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(7))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(6, { endian: 'II' }))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(6, { jfif: true }))).toEqual({ width: 480, height: 640 })
    expect(readImageDimensions(jpegWithOrientation(6, { xmp: true }))).toEqual({ width: 480, height: 640 })
  })

  test('keeps the stored size for orientations 1 to 4 and for a cut-off Exif segment', () => {
    expect(readImageDimensions(jpegWithOrientation(1))).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(jpegWithOrientation(3))).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(jpegWithOrientation(4))).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(jpegWithOrientation(6, { truncated: true }))).toEqual({ width: 640, height: 480 })
    // A TIFF header that is neither II nor MM: magick ignores the block, so the photo is not turned.
    const badOrder = jpegWithOrientation(6)
    badOrder.set([0x58, 0x58], 12)
    expect(readImageDimensions(badOrder)).toEqual({ width: 640, height: 480 })
  })

  test('a file that ends inside its Exif entry gives no size instead of throwing', () => {
    const cut = jpegWithOrientation(6)
    // SOI, the APP1 marker and length, "Exif\0\0", the TIFF header and the entry up to its value: the segment length says 14 bytes of TIFF.
    const file = cut.slice(0, 12 + 14)
    file.set([0x00, 2 + 6 + 14], 4)
    expect(readImageDimensions(file)).toBeUndefined()
  })

  test('the build labels and reports a rotated photo by its displayed size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3676-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/assets'), { recursive: true })
      // Stored 200 wide and 300 tall, displayed 300 by 200 once turned by Orientation 6.
      const stored = Bun.spawnSync(['magick', '-size', '200x300', 'gradient:#c2593f-#2b5876', 'jpg:-']).stdout
      const withExif = jpegWithOrientation(6)
      const app1 = withExif.slice(2, withExif.length - JPEG_640X480.length + 2)
      const photo = new Uint8Array([...stored.subarray(0, 2), ...app1, ...stored.subarray(2)])
      writeFileSync(join(dir, 'src/assets/photo.jpg'), photo)
      // What a build before #3676 left in the cache, under its key of the time: the stored size.
      const oldHash = Bun.hash(`${Bun.hash(photo)}:320:webp:80:55`).toString(36)
      mkdirSync(join(dir, '.kay-cache/images'), { recursive: true })
      writeFileSync(join(dir, `.kay-cache/images/photo-${oldHash}-200w.webp`), 'old')
      writeFileSync(join(dir, `.kay-cache/images/photo-${oldHash}.json`), JSON.stringify({ width: 200, height: 300, files: [{ rel: `img/photo-${oldHash}-200w.webp`, width: 200, format: 'webp' }] }))
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { image } from ${JSON.stringify(IMAGES_MOD)}
import photo from '../assets/photo.jpg'
export default function Home() {
  return <img {...image(photo, { sizes: '100vw' })} alt="p" />
}
`)
      const plugin = images({ widths: [320], formats: ['webp'], quality: 80, avifQuality: 55, cacheDir: join(dir, '.kay-cache/images') })
      await build({ root: dir, plugins: [plugin] })
      const app = await createServer({ root: dir, plugins: [plugin] })
      const html = await (await app.handle(new Request('http://localhost/'))).text()
      expect(html).toContain('width="300"')
      expect(html).toContain('height="200"')
      const variant = /\/(img\/photo-[^ "]+-300w\.webp) 300w/.exec(html)
      expect(variant).not.toBeNull()
      const file = await (await app.handle(new Request(`http://localhost/_kay/${variant![1]}`))).arrayBuffer()
      expect(readImageDimensions(new Uint8Array(file))).toEqual({ width: 300, height: 200 })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a photo whose header kay cannot read takes its turned size from magick identify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3676-identify-'))
    const prevPath = process.env.PATH
    try {
      mkdirSync(join(dir, 'bin'))
      writeFileSync(join(dir, 'bin/magick'), `#!/bin/sh
case "$*" in *identify*) printf '200 300 RightTop'; exit 0;; esac
for last; do :; done
printf 'x' > "$last"
`)
      chmodSync(join(dir, 'bin/magick'), 0o755)
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/assets'), { recursive: true })
      writeFileSync(join(dir, 'src/assets/odd.jpg'), 'bytes only magick reads')
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import odd from '../assets/odd.jpg'
export default function Home() {
  return <img src={odd.src} width={odd.width} height={odd.height} alt="p" />
}
`)
      process.env.PATH = `${join(dir, 'bin')}:${prevPath}`
      const plugin = images({ formats: ['webp'], cacheDir: join(dir, '.kay-cache/images') })
      await build({ root: dir, plugins: [plugin] })
      const app = await createServer({ root: dir, plugins: [plugin] })
      const html = await (await app.handle(new Request('http://localhost/'))).text()
      expect(html).toContain('width="300"')
      expect(html).toContain('height="200"')
    }
    finally {
      process.env.PATH = prevPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

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
