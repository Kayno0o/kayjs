import type { Setup } from './template-shared'

// An API module and a live island over its websocket.
export function wsFiles({ tw }: Setup): Record<string, string> {
  return {
    'src/api/online.ts': `import { s } from 'kay'
import { api } from 'kay/server'

let online = 0

// Served at /api/online: every open connection hears how many there are.
export default api().ws('/', {
  response: s.Object({ online: s.Number() }),
  open(ws) {
    online++
    ws.subscribe('online')
    ws.send({ online })
    ws.publish('online', { online })
  },
  close(ws) {
    online--
    ws.publish('online', { online })
  },
})
`,
    'src/components/online.kay': `---
import { socket } from 'kay'
import online from '../api/online'

const live = socket(online, '/')
---
p${tw('.text-subtext1')} {live.status() === 'open' ? \`\${live.last()?.online ?? 1} online now\` : 'Connecting...'}
`,
  }
}

export const WS_TEST = `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import online from '../src/api/online'

const site = await testSite()

it('tells every visitor how many are online', async () => {
  const first = site.socket(online, '/')

  expect(await first.next()).toEqual({ online: 1 })

  const second = site.socket(online, '/')

  expect(await second.next()).toEqual({ online: 2 })
  expect(await first.next()).toEqual({ online: 2 })

  second.close()
  expect(await first.next()).toEqual({ online: 1 })
  first.close()
})
`
