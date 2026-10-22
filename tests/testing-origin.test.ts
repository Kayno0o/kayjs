import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('kay/test on a project setting no site', () => {
  it('serves a project setting no site at its own origin, as pages reading it render', async () => {
    const unset = await testSite({ root: 'tests/fixtures/production', security: false })

    expect((await unset.visit('/origin')).html).toContain('<p class="origin">http://localhost</p>')
  })
})
