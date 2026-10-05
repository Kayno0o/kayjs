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

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

function pointer(target: Element, type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  const event = new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

// happy-dom lays nothing out, so an element is given the size a browser would have drawn it at.
function sized(el: Element, width: number, height: number): void {
  Object.defineProperties(el, { clientWidth: { value: width }, clientHeight: { value: height } })
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
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

    click(lightbox.querySelector('[data-side="previous"]'))
    await settle()

    expect(lightbox.querySelector('img.kui-media-gallery-full')?.getAttribute('src')).toBe('/c.png')
    expect(lightbox.getAttribute('aria-label')).toBe('Media 3')

    click(lightbox.querySelector('.kui-media-gallery-close'))
    await settle()

    expect(lightbox.open).toBe(false)
  })

  test('goes to either end with Home and End, turns on a horizontal swipe of a finger alone, and names untitled items', async () => {
    const root = await media()
    const gallery = root.querySelector('#gallery')!
    const stage = gallery.querySelector('.kui-media-gallery-stage')!

    expect([...gallery.querySelectorAll('.kui-media-gallery-thumb')].map(thumb => thumb.getAttribute('aria-label'))).toEqual(['Mars', 'Media 2', 'Media 3'])
    expect(gallery.querySelector('.kui-media-gallery-zoom')?.getAttribute('aria-label')).toBe('Open full size: Mars')

    press(stage, 'End')
    press(stage, 'Home')
    expect(press(stage, 'ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false)

    pointer(stage, 'pointerdown', 200, 100, { pointerType: 'touch' })
    pointer(stage, 'pointerup', 100, 110, { pointerType: 'touch' })
    pointer(stage, 'pointerdown', 200, 100, { pointerType: 'touch' })
    pointer(stage, 'pointerup', 140, 200, { pointerType: 'touch' })
    pointer(stage, 'pointerdown', 200, 100)
    pointer(stage, 'pointerup', 100, 100)
    await settle()

    expect(seen.index).toEqual([2, 0, 1])
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

  test('leaves Ctrl with + or 0 to the browser\'s zoom, and the wheel to the page while fitted unless Ctrl is held', async () => {
    const root = await media()
    const pane = root.querySelector('#zoom')!
    const scale = () => Number(pane.querySelector<HTMLElement>('.kui-zoom-plate')!.style.getPropertyValue('--kui-zoom-scale'))
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true, ...init })

      // happy-dom's WheelEvent drops the modifier keys it is given.
      Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false })
      pane.dispatchEvent(event)

      return event
    }

    expect(press(pane, '+', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(wheel({}).defaultPrevented).toBe(false)
    await settle()

    expect(scale()).toBe(1)
    expect(wheel({ ctrlKey: true }).defaultPrevented).toBe(true)
    await settle()

    expect(scale()).toBeCloseTo(1.15)
    expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(true)
    await settle()

    expect(scale()).toBeCloseTo(1)
  })

  test('takes the picture in on a double click and a pinch, and moves it by a drag once it has wandered', async () => {
    const root = await media()
    const pane = root.querySelector('#zoom')!
    const plate = () => pane.querySelector<HTMLElement>('.kui-zoom-plate')!.style

    sized(pane, 200, 100)
    pane.dispatchEvent(new MouseEvent('dblclick', { clientX: 100, clientY: 50, bubbles: true }))
    await settle()

    expect(Number(plate().getPropertyValue('--kui-zoom-scale'))).toBeCloseTo(1.15 ** 3)

    pointer(pane, 'pointerdown', 100, 50)
    pointer(pane, 'pointermove', 101, 50)
    await settle()

    expect(pane.hasAttribute('data-dragging')).toBe(false)

    const before = plate().transform

    pointer(pane, 'pointermove', 90, 50)
    await settle()

    expect([pane.hasAttribute('data-dragging'), plate().transform === before]).toEqual([true, false])

    pointer(pane, 'pointerup', 90, 50)
    press(pane, '0')
    pointer(pane, 'pointerdown', 90, 50, { pointerId: 1, pointerType: 'touch' })
    pointer(pane, 'pointerdown', 110, 50, { pointerId: 2, pointerType: 'touch' })
    pointer(pane, 'pointermove', 130, 50, { pointerId: 2, pointerType: 'touch' })
    await settle()

    expect(Number(plate().getPropertyValue('--kui-zoom-scale'))).toBeCloseTo(2)
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

  test('moves the crop by a drag, resizes it by a corner or Shift with an arrow, and reads it out', async () => {
    const root = await media()
    const image = root.querySelector<HTMLImageElement>('.kui-image-cropper-image')!
    const stage = root.querySelector('.kui-image-cropper-stage')!

    sized(stage, 400, 300)
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 } })
    image.dispatchEvent(new Event('load'))
    await settle()

    const crop = root.querySelector('.kui-image-cropper-crop')!

    expect([crop.getAttribute('aria-valuetext'), crop.getAttribute('aria-valuemin'), crop.getAttribute('aria-valuemax')]).toEqual(['400 by 200 pixels at 0, 50', '32', '400'])

    pointer(crop, 'pointerdown', 200, 150)
    pointer(stage, 'pointermove', 200, 120)
    pointer(stage, 'pointerup', 200, 120)
    pointer(stage, 'pointermove', 200, 300)

    expect(seen.crops.at(-1)).toEqual({ x: 0, y: 20, w: 400, h: 200 })

    pointer(crop.querySelector('[data-handle="se"]')!, 'pointerdown', 400, 220)
    pointer(stage, 'pointermove', 200, 220)
    pointer(stage, 'pointerup', 200, 220)

    expect(seen.crops.at(-1)!.w).toBe(200)

    press(crop, 'ArrowLeft', { shiftKey: true })

    expect(seen.crops.at(-1)!.w).toBeLessThan(200)
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
