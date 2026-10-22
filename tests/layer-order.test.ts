import { describe, expect, it } from 'bun:test'
import { hoistLayerOrder } from '../src/build/layer-order'

describe('hoistLayerOrder', () => {
  it('moves the app\'s layer order ahead of a component stylesheet\'s layer block', () => {
    const css = '@layer components{.chat{color:red}}@layer properties;@layer docs,theme,base,components,utilities;@layer docs{a{color:blue}}'

    expect(hoistLayerOrder(css)).toBe('@layer properties;@layer docs,theme,base,components,utilities;@layer components{.chat{color:red}}@layer docs{a{color:blue}}')
  })

  it('keeps the statements in the order written, an early one included', () => {
    expect(hoistLayerOrder('@layer a;.x{}@layer b;')).toBe('@layer a;@layer b;.x{}')
  })

  it('leaves a stylesheet whose statements already lead alone', () => {
    const css = '@layer theme, base, components, utilities;\n@layer components { .x { color: red } }\n'

    expect(hoistLayerOrder(css)).toBe(css)
  })

  it('keeps @charset first', () => {
    expect(hoistLayerOrder('@charset "utf-8";.x{}@layer a, b;')).toBe('@charset "utf-8";@layer a, b;.x{}')
  })

  it('reads dotted layer names and leaves nested statements, strings and comments where they are', () => {
    const css = '.x{content:"@layer fake;"}/* @layer gone; */@layer outer{@layer inner;}@layer app.base, app.top;'

    expect(hoistLayerOrder(css)).toBe('@layer app.base, app.top;.x{content:"@layer fake;"}/* @layer gone; */@layer outer{@layer inner;}')
  })
})
