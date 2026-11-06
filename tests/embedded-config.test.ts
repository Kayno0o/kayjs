import type { Bundle } from '../src/server/bundle'
import { expect, it } from 'bun:test'
import { projectPaths } from '../src/project'
import { embeddedSource } from '../src/server/source'

const bundle = (config: object) => ({ config, root: '/app', publicDir: '/app/static', modules: {} }) as unknown as Bundle

it.each([
  ['dirs.public', { dirs: { public: 'elsewhere', routes: 'pages' } }, '/app/pages'],
])('an executable serves the public folder it was built with over %s of the config and the options', async (_, config, routes) => {
  const source = embeddedSource(bundle(config))

  for (const options of [{}, { dirs: { public: 'again' } }]) {
    const merged = await source.config('/anywhere', options)

    expect(projectPaths('/app', merged).public).toBe('/app/static')
  }

  expect(projectPaths('/app', await source.config('/anywhere', {})).routes).toBe(routes)
})
