import { existsSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
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

    const told = cms({ files: workingTree() }).server

    expect(typeof told === 'function' && told()).toBeTruthy()

    process.env.NODE_ENV = 'development'

    const dev = cms().server

    expect(typeof dev === 'function' && dev()).toBeTruthy()
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
