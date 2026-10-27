import type { ShadowSettings } from '../src/check/shadow'
import type { KayConfig } from '../src/config'
import type { RouteMount } from '../src/server/routes'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CHECK_CONFIG, configCheckOptions } from '../src/check'
import { readShadowSettings, serializeShadowSettings, SHADOW_SETTINGS, shadowOptionsFor } from '../src/check/shadow'
import { CLIENT_CONFIG, clientOptionsOf, PRODUCTION, projectPaths, RENDER_CONFIG, renderOptionsOf } from '../src/project'
import { scratchDir } from './scratch'

// A config setting each key to a value of its own, which a view passing the key on carries unchanged.
function marked(keys: readonly (keyof KayConfig)[]): KayConfig {
  return Object.fromEntries(keys.map(key => [key, `${key} as configured`]))
}

describe('the views of the config', () => {
  it.each([
    ['kay check', CHECK_CONFIG, (config: KayConfig) => configCheckOptions(config)],
    ['the browser build', CLIENT_CONFIG, (config: KayConfig) => clientOptionsOf(config, PRODUCTION)],
    ['the renderer', RENDER_CONFIG, (config: KayConfig) => renderOptionsOf(config, PRODUCTION, { head: undefined, maxDensity: 2 })],
  ] as const)('%s takes every key its list names as written', (_, keys, view) => {
    const config = marked(keys)

    expect(view(config)).toMatchObject(config)
  })

  it('kay check takes no key its list leaves out', () => {
    expect(Object.keys(configCheckOptions({ cors: { origins: ['*'] }, minify: true, ...marked(CHECK_CONFIG) })).sort()).toEqual([...CHECK_CONFIG].sort())
  })

  // Typed whole, so a field added to ShadowSettings fails the type check until the sample sets it, then this test until both functions carry it.
  it('the shadow settings eslint and the LSP read back are the ones check wrote', async () => {
    const root = await scratchDir('shadow-settings-')
    const mounts: Pick<Required<RouteMount>, 'dir' | 'prefix' | 'outer'>[] = [{ dir: join(root, 'node_modules/lib/routes'), prefix: '/lib', outer: join(root, 'node_modules/lib/_outer.kay') }]
    const settings: Required<ShadowSettings> = {
      routesDir: join(root, 'pages'),
      mounts,
      islandOnly: new Set([join(root, 'pages/_widget.kay')]),
      publicDir: join(root, 'static'),
      lints: { a11y: 'deny' },
    }

    await Bun.write(join(projectPaths(root).types, SHADOW_SETTINGS), serializeShadowSettings(root, settings))

    expect(readShadowSettings(root)).toEqual(settings)
    expect(shadowOptionsFor(readShadowSettings(root), join(root, 'pages/_widget.kay'))).toEqual({ routesDir: settings.routesDir, mounts, insideIsland: true, lints: settings.lints })
    expect(shadowOptionsFor(readShadowSettings(root), join(root, 'pages/index.kay')).insideIsland).toBe(false)
  })
})
