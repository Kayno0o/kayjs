import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { browserLive } from '../src/runtime/live-value.client'
import { effect, root } from '../src/runtime/reactive'
import '../src/test/dom'

describe('a keyed live value read in the browser', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('warns once in development when an effect reads a key the render never noted', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const rooms = browserLive('unnoted-room', (id: string) => ({ id })) as unknown as (key: string) => unknown

      const dispose = root((stop) => {
        effect(() => {
          rooms('quiet')
        })

        return stop
      })

      await Bun.sleep(10)
      dispose()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('unnoted-room')
    }
    finally {
      warn.mockRestore()
    }
  })
  it('says nothing of a read outside an effect or a template, which follows nothing', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const rooms = browserLive('plain-room', (id: string) => ({ id })) as unknown as (key: string) => unknown

      rooms('quiet')
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })
})
