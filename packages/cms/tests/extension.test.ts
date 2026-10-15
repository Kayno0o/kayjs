import { afterEach, describe, expect, test } from 'bun:test'
import { cms } from '../src/extension'
import { workingTree } from '../src/files'

const environment = process.env.NODE_ENV

afterEach(() => {
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
