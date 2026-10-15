// Runs `focusInvalid` in a process of its own where the reveal's chunk fails to load, as one a deploy replaced does, and prints whether a field took focus and the details stayed closed.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const REVEAL_MODULE = /[/\\]runtime[/\\]reveal\.ts$/

Bun.plugin({
  name: 'stale reveal',
  setup(build) {
    build.onLoad({ filter: REVEAL_MODULE }, () => {
      throw new Error('stale chunk')
    })
  },
})

GlobalRegistrator.register()
document.body.innerHTML = '<details><summary>More</summary><input aria-label="Code" aria-invalid="true"></details>'

const { focusInvalid } = await import('../../../src/runtime/focus')

console.log(JSON.stringify({ focused: await focusInvalid(), open: document.querySelector('details')!.open }))
await GlobalRegistrator.unregister()
