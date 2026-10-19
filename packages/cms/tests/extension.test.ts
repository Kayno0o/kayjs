import { existsSync } from 'node:fs'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { cms } from '../src/extension'
import { workingTree } from '../src/files'

const environment = process.env.NODE_ENV
const devCode = process.env.KAY_DEV_CODE

afterEach(() => {
  if (devCode === undefined)
    delete process.env.KAY_DEV_CODE
  else
    process.env.KAY_DEV_CODE = devCode

  if (environment === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = environment
})

describe('cms()', () => {
  test('refuses to boot a production server that would save to the working tree by default', () => {
    process.env.NODE_ENV = 'production'

    const { server } = cms()

    expect(() => {
      if (typeof server === 'function')
        void server()
    }).toThrow('kayjs-cms: a production server saves no edit to the working tree')
  })

  test('boots a production server told where files go, and any server outside production', () => {
    process.env.NODE_ENV = 'production'

    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const told = cms({ files: workingTree() }).server

    expect(typeof told === 'function' && told()).toBeTruthy()
    warned.mockRestore()

    process.env.NODE_ENV = 'development'

    const dev = cms().server

    expect(typeof dev === 'function' && dev()).toBeTruthy()
  })

  test('warns a server outside kay dev without a guard, naming cms({ guard }), and no other', () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const boot = (underDev: boolean, options: Parameters<typeof cms>[0]): string[] => {
      if (underDev)
        process.env.KAY_DEV_CODE = '0'
      else
        delete process.env.KAY_DEV_CODE

      warned.mockClear()

      const { server } = cms({ files: workingTree(), ...options })

      if (typeof server === 'function')
        void server()

      return warned.mock.calls.map(call => String(call[0]))
    }

    try {
      expect(boot(false, {})).toEqual([expect.stringContaining('no cms({ guard })')])
      expect(boot(false, { guard: () => undefined })).toEqual([])
      expect(boot(true, {})).toEqual([])
    }
    finally {
      warned.mockRestore()
    }
  })
})

describe('the dev tool\'s CMS tab', () => {
  const ask = async (): Promise<Response> => {
    const { server } = cms({ prefix: '/studio' })
    const plugin = typeof server === 'function' ? await server() : server!

    return plugin.handle(new Request('http://localhost/_kay/cms'))
  }

  test('names its browser module, and answers whether the visitor is editing under kay dev', async () => {
    process.env.KAY_DEV_CODE = '0'

    expect(existsSync(cms().devTool!.module)).toBe(true)

    const response = await ask()

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ editing: false, prefix: '/studio', exit: '/api/cms/preview/exit' })
  })

  test('answers nothing outside kay dev', async () => {
    delete process.env.KAY_DEV_CODE

    expect((await ask()).status).toBe(404)
  })
})

describe('cms() missing field kinds', () => {
  test('warns once the server starts for a custom kind the project has no component for', async () => {
    const { server } = cms({ files: workingTree(), guard: () => undefined })
    const { registerCollections } = await import('../../../src/content/edit')
    const { setContentPlace } = await import('../../../src/content/load')
    const config = await import('./fixture/src/content.config') as Record<string, unknown>
    const before = registerCollections(Object.entries(config) as Parameters<typeof registerCollections>[0])
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = (typeof server === 'function' ? await server() : server)!

    try {
      // The working directory is the package's, not the project: the root is the one the content config settled.
      setContentPlace(`${import.meta.dir}/fixture`, `${import.meta.dir}/fixture/src`)
      app.listen(0)
      await Bun.sleep(50)

      expect(warned.mock.calls.map(call => String(call[0]))).toEqual(['kayjs-cms: no editor for the mood kind that products uses: add src/cms/fields/mood.kay, until then it is edited as JSON'])
    }
    finally {
      await app.stop()
      warned.mockRestore()
      registerCollections(before)
    }
  })
})
