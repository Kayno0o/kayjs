import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { memoryRooms, rooms, sqliteRooms } from '../src/server/rooms'

interface State { round: number, scores: Record<string, number>, at?: Date }
type Message = { type: 'state', state: State } | { type: 'said', text: string }

const options = { state: (): State => ({ round: 0, scores: {} }), snapshot: (state: State): Message => ({ type: 'state', state }) }

function connection() {
  const received: string[] = []

  return { received, raw: { sendText: (text: string) => void received.push(text) } }
}

const snapshotOf = (state: State) => JSON.stringify({ type: 'state', state })

async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited > 2_000)
      throw new Error('timed out')

    await Bun.sleep(5)
  }
}

describe('a room\'s state in memory', () => {
  it('sends a joiner the state as it stands, to the joiner alone, again on a rejoin', () => {
    const live = rooms<Message, string, State>(options)
    const [ada, bob] = [connection(), connection()]

    live.join(ada, 'hall', 'ada')
    expect(ada.received).toEqual([snapshotOf({ round: 0, scores: {} })])
    expect(live.update('hall', state => ({ ...state, round: state.round + 1 }))).toEqual({ round: 1, scores: {} })
    live.join(bob, 'hall', 'bob')
    expect(bob.received).toEqual([snapshotOf({ round: 1, scores: {} })])
    expect(ada.received).toHaveLength(1)

    live.join(bob, 'hall', 'bobby')
    expect(bob.received).toHaveLength(2)
    expect(live.members('hall')).toEqual(['ada', 'bobby'])
  })

  it('serves two joiners at once the same latest state, and reads each update from the one before', () => {
    const live = rooms<Message, undefined, State>(options)
    const joiners = [connection(), connection(), connection()]

    live.update('hall', state => ({ ...state, round: 1 }))
    live.update('hall', state => ({ ...state, round: state.round + 1 }))

    for (const joiner of joiners)
      live.join(joiner, 'hall')

    for (const joiner of joiners)
      expect(joiner.received).toEqual([snapshotOf({ round: 2, scores: {} })])
  })

  it('drops the state with the last member, keeping it while another is left', () => {
    const live = rooms<Message, undefined, State>(options)
    const [ada, bob] = [connection(), connection()]

    live.join(ada, 'hall')
    live.join(bob, 'hall')
    live.update('hall', state => ({ ...state, round: 5 }))
    live.leave(ada)
    expect(live.state('hall').round).toBe(5)
    live.leave(bob)
    expect(live.state('hall')).toEqual({ round: 0, scores: {} })

    const late = connection()

    live.join(late, 'hall')
    expect(late.received).toEqual([snapshotOf({ round: 0, scores: {} })])
  })

  it('keeps each room\'s state apart, and leave(ws) of every room drops each', () => {
    const live = rooms<Message, undefined, State>(options)
    const ada = connection()

    live.join(ada, 'a')
    live.join(ada, 'b')
    live.update('a', state => ({ ...state, round: 1 }))
    live.update('b', state => ({ ...state, round: 2 }))
    expect([live.state('a').round, live.state('b').round]).toEqual([1, 2])
    live.leave(ada)
    expect([live.state('a').round, live.state('b').round]).toEqual([0, 0])
  })

  it('keeps the state as JSON: a Date comes back as text, a value with none is refused before anything is stored', () => {
    const live = rooms<Message, undefined, State>(options)

    live.update('hall', state => ({ ...state, at: new Date(Date.UTC(2026, 0, 1)) }))
    expect(live.state('hall').at as unknown).toBe('2026-01-01T00:00:00.000Z')
    expect(() => live.update('hall', () => undefined as never)).toThrow('must be JSON')
    expect(live.state('hall').round).toBe(0)
    expect(() => live.update('hall', () => ({ round: 1n }) as never)).toThrow()
    expect(live.state('hall').at as unknown).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps a __proto__ key of the state as data', () => {
    const live = rooms<Message, undefined, State>(options)

    live.update('hall', () => JSON.parse('{"round":1,"scores":{"__proto__":{"admin":1}}}') as State)
    expect(({} as { admin?: number }).admin).toBeUndefined()
    expect(Object.keys(live.state('hall').scores)).toEqual(['__proto__'])
  })

  it('changes nothing for a room without a state option', () => {
    const live = rooms<{ text: string }, string>()
    const ada = connection()

    live.join(ada, 'hall', 'ada')
    expect(ada.received).toEqual([])
    expect(live.members('hall')).toEqual(['ada'])
    live.publish('hall', { text: 'hi' })
    expect(ada.received).toEqual(['{"text":"hi"}'])
  })

  it('sends no snapshot without the option, though the room keeps a state', () => {
    const live = rooms<Message, undefined, State>({ state: options.state })
    const ada = connection()

    live.join(ada, 'hall')
    expect(ada.received).toEqual([])
    expect(live.update('hall', state => ({ ...state, round: 3 })).round).toBe(3)
  })

  it('refuses a store that cannot keep a state', () => {
    const { add, remove, members, publish, subscribe, close } = memoryRooms()
    const bare = { add, remove, members, publish, subscribe, close }

    expect(() => rooms<Message, undefined, State>({ ...options, store: bare })).toThrow('keeps a room\'s state')
  })

  it('is typed: the state option is required for a state type, the snapshot a message', () => {
    const typed = () => {
      // @ts-expect-error: a room with a state type declares its initial state
      rooms<Message, undefined, State>()
      // @ts-expect-error: the snapshot is a Message
      rooms<Message, undefined, State>({ state: options.state, snapshot: () => 'nope' })
      // @ts-expect-error: the update returns a State
      rooms<Message, undefined, State>(options).update('a', () => ({ round: 'x' }))
    }

    void typed
  })
})

describe('a room\'s state in a SQLite file', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kay-room-state-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Two stores on one file stand for two processes.
  function processes(name: string) {
    const stores = [sqliteRooms(join(dir, `${name}.sqlite`), { poll: '5ms' }), sqliteRooms(join(dir, `${name}.sqlite`), { poll: '5ms' })] as const

    return { stores, first: rooms<Message, string, State>({ ...options, store: stores[0] }), second: rooms<Message, string, State>({ ...options, store: stores[1] }), close: () => {
      for (const store of stores)
        store.close()
    } }
  }

  it('shares the state between two processes: a late joiner of the other one gets the latest', () => {
    const { first, second, close } = processes('shared')
    const [ada, bob] = [connection(), connection()]

    try {
      first.join(ada, 'hall', 'ada')
      first.update('hall', state => ({ ...state, round: 4 }))
      second.join(bob, 'hall', 'bob')
      expect(bob.received).toEqual([snapshotOf({ round: 4, scores: {} })])
      expect(second.update('hall', state => ({ ...state, round: state.round + 1 })).round).toBe(5)
      expect(first.state('hall').round).toBe(5)
    }
    finally {
      close()
    }
  })

  it('loses no update when two processes change one room in turn', () => {
    const { first, second, close } = processes('turns')
    const [ada, bob] = [connection(), connection()]

    try {
      first.join(ada, 'hall', 'x')
      second.join(bob, 'hall', 'x')

      for (let turn = 0; turn < 50; turn++)
        (turn % 2 === 0 ? first : second).update('hall', state => ({ ...state, round: state.round + 1 }))

      expect(first.state('hall').round).toBe(50)
      expect(second.state('hall').round).toBe(50)
    }
    finally {
      close()
    }
  })

  it('keeps the state while a member of any process is left, and drops it with the last', () => {
    const { first, second, close } = processes('lasts')
    const [ada, bob] = [connection(), connection()]

    try {
      first.join(ada, 'hall', 'x')
      second.join(bob, 'hall', 'x')
      first.update('hall', state => ({ ...state, round: 7 }))
      first.leave(ada)
      expect(second.state('hall').round).toBe(7)
      second.leave(bob)
      expect(first.state('hall').round).toBe(0)
    }
    finally {
      close()
    }
  })

  it('drops the state of a room whose only process died', async () => {
    const path = join(dir, 'crashed.sqlite')
    const store = sqliteRooms(path, { poll: '5ms' })
    const live = rooms<Message, string, State>({ ...options, store })
    const ada = connection()

    live.join(ada, 'hall', 'ada')
    live.update('hall', state => ({ ...state, round: 9 }))

    const file = new Database(path)

    try {
      file.run('UPDATE kay_room_processes SET seen = 1')

      const survivor = sqliteRooms(path, { poll: '5ms' })
      const watcher = rooms<Message, string, State>({ ...options, store: survivor })
      const bob = connection()

      watcher.join(bob, 'other', 'bob')
      await until(() => file.query('SELECT 1 FROM kay_room_state').all().length === 0)
      expect(watcher.state('hall').round).toBe(0)
      survivor.close()
    }
    finally {
      file.close()
      store.close()
    }
  })

  it('opens a file from before room states, adding the table', () => {
    const path = join(dir, 'old.sqlite')
    const old = new Database(path)

    old.run('CREATE TABLE kay_room_members (room TEXT NOT NULL, connection TEXT NOT NULL, process TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (room, connection))')
    old.close()

    const store = sqliteRooms(path)

    try {
      const live = rooms<Message, undefined, State>({ ...options, store })

      expect(live.update('hall', state => ({ ...state, round: 1 })).round).toBe(1)
    }
    finally {
      store.close()
    }
  })
})
