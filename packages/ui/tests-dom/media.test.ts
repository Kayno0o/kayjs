import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

// Stand-ins for the observers happy-dom lacks or never fires: each one made is kept, to be fired by hand.
class Observer {
  static made: Observer[] = []
  observed: Element[] = []

  constructor(public callback: (entries: unknown[]) => void) {
    Observer.made.push(this)
  }

  observe(element: Element) {
    this.observed.push(element)
  }

  // Stopping matters to no test: an observer only fires when one calls it.
  unobserve = () => undefined
  disconnect = () => undefined
}

const { IntersectionObserver, ResizeObserver } = globalThis
let mounted: Mounted | undefined
const seen: { index: number[], crops: { x: number, y: number, w: number, h: number }[], more: number } = { index: [], crops: [], more: 0 }

beforeEach(() => {
  Observer.made = []
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer })
})

afterEach(() => {
  mounted?.unmount()
  Object.assign(globalThis, { IntersectionObserver, ResizeObserver })
  seen.index = []
  seen.crops = []
  seen.more = 0
})

async function media() {
  mounted = await mount('src/components/media.kay', { onIndexChange: (index: number) => seen.index.push(index), onCrop: (crop: typeof seen.crops[number]) => seen.crops.push(crop), onMore: () => seen.more++ })

  return mounted.root
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

describe('MediaGallery', () => {
  test('turns with its buttons and the arrows, wrapping, playing a video in place of the stage\'s image', async () => {
    const root = await media()
    const gallery = root.querySelector('#gallery')!
    const counter = () => gallery.querySelector('.kui-media-gallery-counter')?.textContent

    expect(counter()).toBe('1 / 3')
    expect(gallery.querySelector('.kui-media-gallery-stage img')?.getAttribute('src')).toBe('/a.png')
    expect(gallery.querySelector('.kui-media-gallery-thumb')?.getAttribute('aria-current')).toBe('true')

    click(gallery.querySelector('[data-side="next"]'))
    await settle()

    expect(counter()).toBe('2 / 3')
    expect(gallery.querySelector<HTMLVideoElement>('.kui-media-gallery-stage video')?.src).toEndWith('/b.mp4')

    press(gallery.querySelector('.kui-media-gallery-thumb')!, 'ArrowLeft')
    press(gallery.querySelector('.kui-media-gallery-thumb')!, 'ArrowLeft')
    await settle()

    expect(counter()).toBe('3 / 3')
    expect(seen.index).toEqual([1, 0, 2])
  })

  test('opens an image full size in a lightbox, closed by its button', async () => {
    const root = await media()
    const lightbox = root.querySelector<HTMLDialogElement>('.kui-media-gallery-lightbox')!

    click(root.querySelector('.kui-media-gallery-zoom'))
    await settle()

    expect(lightbox.open).toBe(true)
    expect(lightbox.querySelector('img.kui-media-gallery-full')?.getAttribute('src')).toBe('/a-full.png')

    click(lightbox.querySelector('.kui-media-gallery-close'))
    await settle()

    expect(lightbox.open).toBe(false)
  })
})

describe('ZoomPane', () => {
  test('zooms with + and fits again with 0, its fit button enabled only once zoomed', async () => {
    const root = await media()
    const pane = root.querySelector('#zoom')!
    const fit = () => pane.querySelector<HTMLButtonElement>('[aria-label="Fit"]')!

    expect(fit().disabled).toBe(true)

    press(pane, '+')
    await settle()

    expect(pane.querySelector<HTMLElement>('.kui-zoom-plate')?.style.getPropertyValue('--kui-zoom-scale')).toBe('1.15')
    expect(fit().disabled).toBe(false)

    press(pane, '0')
    await settle()

    expect(pane.querySelector<HTMLElement>('.kui-zoom-plate')?.style.getPropertyValue('--kui-zoom-scale')).toBe('1')
  })
})

describe('ImageCropper', () => {
  test('centres a crop of its ratio once the image has loaded, moves it with the arrows, and resets it', async () => {
    const root = await media()
    const image = root.querySelector<HTMLImageElement>('.kui-image-cropper-image')!

    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 } })
    image.dispatchEvent(new Event('load'))
    await settle()

    expect(seen.crops.at(-1)).toEqual({ x: 0, y: 50, w: 400, h: 200 })

    press(root.querySelector('.kui-image-cropper-crop')!, 'ArrowUp')
    await settle()

    expect(seen.crops.at(-1)).toEqual({ x: 0, y: 46, w: 400, h: 200 })

    click(root.querySelector('#reset'))

    expect(seen.crops.at(-1)).toEqual({ x: 0, y: 50, w: 400, h: 200 })
  })
})

describe('Masonry and WhenVisible', () => {
  test('drops each tile into the shortest lane once the widths and heights are known', async () => {
    const root = await media()
    const masonry = root.querySelector<HTMLElement>('#masonry')!
    const observer = Observer.made.find(made => made.observed.includes(masonry))!
    const tiles = [...masonry.querySelectorAll<HTMLElement>('.kui-masonry-item')]

    expect(masonry.hasAttribute('data-laid-out')).toBe(false)

    observer.callback([{ target: masonry, contentRect: { width: 524 } }, ...tiles.map((tile, index) => ({ target: tile, borderBoxSize: [{ blockSize: [100, 40, 60][index] }] }))])
    await settle()

    expect(masonry.style.getPropertyValue('--kui-masonry-lanes')).toBe('2')
    expect(tiles.map(tile => [tile.style.getPropertyValue('--kui-masonry-lane'), tile.style.getPropertyValue('--kui-masonry-top')])).toEqual([['0', '0px'], ['1', '0px'], ['1', '52px']])
    expect(masonry.style.height).toBe('112px')
  })

  test('asks for more once the sentinel comes into view', async () => {
    const root = await media()
    const sentinel = root.querySelector('.kui-when-visible')!
    const observer = Observer.made.find(made => made.observed.includes(sentinel))!

    observer.callback([{ isIntersecting: false }])

    expect(seen.more).toBe(0)

    observer.callback([{ isIntersecting: true }])

    expect(seen.more).toBe(1)
  })
})
