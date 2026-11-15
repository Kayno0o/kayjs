import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { shutdown } from '../src/server/lifecycle'
import { rooms } from '../src/server/rooms'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

function connection(data?: unknown) {
  const received: string[] = []
  const closed: [number | undefined, string | undefined][] = []

  return { received, closed, data, raw: { sendText: (text: string) => void received.push(text), close: (code?: number, reason?: string) => void closed.push([code, reason]) } }
}

async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 5_000)
      throw new Error('timed out')

    await Bun.sleep(10)
  }
}

describe('rooms hooks', () => {
  it('lists a joiner as what `member` reads from the connection, a given member winning', () => {
    const chats = rooms<string, string>({ member: ws => (ws.data as { name: string }).name })
    const ada = connection({ name: 'ada' })
    const bob = connection({ name: 'bob' })

    expect(chats.join(ada, 'hall')).toBe(true)
    chats.join(bob, 'hall', 'robert')
    expect(chats.members('hall').sort()).toEqual(['ada', 'robert'])
    expect(chats.memberOf(ada, 'hall')).toBe('ada')
  })

  it('refuses a join `beforeJoin` turns down, closing the socket, and tells nothing of it', async () => {
    const told: string[] = []
    const chats = rooms<string, string>({
      beforeJoin: ({ room, member }) => (room === 'staff' && member !== 'ada' ? 'staff only' : undefined),
      onJoin: ({ room, member }) => void told.push(`join ${room} ${member}`),
    })
    const bob = connection()

    expect(chats.join(bob, 'staff', 'bob')).toBe(false)
    expect(bob.closed).toEqual([[1008, 'staff only']])
    expect(chats.members('staff')).toEqual([])
    expect(chats.join(connection(), 'staff', 'ada')).toBe(true)
    await Bun.sleep(0)
    expect(told).toEqual(['join staff ada'])
  })

  it('refuses with false, and when beforeJoin throws', () => {
    const chats = rooms<string>({ beforeJoin: ({ room }) => {
      if (room === 'boom')
        throw new Error('no')

      return room !== 'closed'
    } })
    const ws = connection()

    expect(chats.join(ws, 'closed')).toBe(false)
    expect(ws.closed).toEqual([[1008, 'Refused']])
    expect(chats.join(connection(), 'boom')).toBe(false)
    expect(chats.join(connection(), 'open')).toBe(true)

    const asked = rooms<string>({ beforeJoin: (async () => true) as never })

    expect(asked.join(connection(), 'late')).toBe(false)
  })

  it('refuses when member throws, handles a rejected async beforeJoin, and never keeps a closed socket', async () => {
    const throwing = rooms<string, string>({ member: () => {
      throw new Error('no user')
    } })
    const ws = connection()

    expect(throwing.join(ws, 'hall')).toBe(false)
    expect(ws.closed).toEqual([[1008, 'Refused']])

    const unhandled: unknown[] = []
    const catcher = (reason: unknown) => void unhandled.push(reason)

    process.on('unhandledRejection', catcher)

    try {
      const asked = rooms<string>({ beforeJoin: (async () => {
        throw new Error('async')
      }) as never })

      expect(asked.join(connection(), 'hall')).toBe(false)
      await Bun.sleep(20)
      expect(unhandled).toEqual([])
    }
    finally {
      process.off('unhandledRejection', catcher)
    }

    const chats = rooms<string>()
    const gone = connection()

    ;(gone.raw as { readyState?: number }).readyState = 3
    expect(chats.join(gone, 'hall')).toBe(false)
    expect(chats.members('hall')).toEqual([])
  })

  it('reads the route data as written, without a cast', () => {
    // eslint-disable-next-line ts/no-unsafe-member-access
    const chats = rooms<string, string>({ member: ws => ws.data.user.name as string })

    expect(chats.join(connection({ user: { name: 'ada' } }), 'hall')).toBe(true)
    expect(chats.members('hall')).toEqual(['ada'])
  })

  it('tells onJoin once per new room, and onLeave on leave with the member it had', async () => {
    const told: string[] = []
    const chats = rooms<string, string>({
      onJoin: ({ room, member }) => void told.push(`join ${room} ${member}`),
      onLeave: ({ room, member }) => void told.push(`leave ${room} ${member}`),
    })
    const ada = connection()

    chats.join(ada, 'hall', 'ada')
    chats.join(ada, 'hall', 'ada again')
    chats.leave(ada)
    chats.leave(ada)
    await Bun.sleep(0)
    expect(told).toEqual(['join hall ada', 'leave hall ada again'])
  })
})

describe('a ws route joining a room', () => {
  let dir = ''

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('leaves every room when its socket closes, after its own close ran', async () => {
    dir = await scratchDir('rooms-hooks-')

    const log: string[] = (globalThis as { roomsLog?: string[] }).roomsLog = []

    await Bun.write(join(dir, 'api/chat.ts'), `import { api, rooms } from 'kay/server'

const log = (globalThis as { roomsLog?: string[] }).roomsLog!
const chats = rooms<string, string>({ onLeave: ({ room, member }) => void log.push(\`left \${room} \${member}\`) })

export default api().ws('/', {
  response: chats.response,
  open(ws) {
    chats.join(ws, 'hall', 'ada')
    ws.send('joined')
  },
  close(ws) {
    log.push(\`closing as \${chats.memberOf(ws, 'hall')}\`)
  },
})
`)

    const app = await pages({ root: dir, dirs: { routes: 'routes', api: 'api' }, prebuilt: false, guards: { default: 'open' } } as never)

    app.listen({ port: 0, hostname: '127.0.0.1' })

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${app.server?.port}/api/chat`)

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('message', () => resolve())
        socket.addEventListener('error', () => reject(new Error('the socket failed')))
      })
      socket.close()
      await until(() => log.length >= 2)
      expect(log).toEqual(['closing as ada', 'left hall ada'])
    }
    finally {
      await shutdown(app, true)
    }
  })
})
