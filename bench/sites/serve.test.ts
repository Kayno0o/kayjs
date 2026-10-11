import { describe, expect, it } from 'bun:test'
import { cpuTicks, ensureFree, parentOf, processTree, treeMemory } from './serve'

describe('parentOf', () => {
  it('reads the parent after the name, whatever spaces and parentheses the name holds', () => {
    expect(parentOf('4242 (bun) S 17 4242 4242 0 -1')).toBe(17)
    expect(parentOf('4242 (a (b) c) S) R 99 4242 4242 0 -1')).toBe(99)
  })
})

describe('cpuTicks', () => {
  it('adds a process\'s user and system time to those of the children it reaped', () => {
    expect(cpuTicks('4242 (a (b) c) S 17 4242 4242 0 -1 4194560 900 30 0 0 120 30 400 50 20 0 9 0')).toBe(600)
  })
})

describe('ensureFree', () => {
  it('fails on a port something answers on, and lets a free one through', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stale') })
    const port = server.port!

    let refused: unknown

    try {
      await ensureFree(port, 'bakery kay')
    }
    catch (error) {
      refused = error
    }
    finally {
      await server.stop(true)
    }

    expect(String(refused)).toContain(`bakery kay: something already answers on port ${port}`)

    expect(await ensureFree(port, 'bakery kay')).toBeUndefined()
  })
})

describe('processTree', () => {
  it('holds a process and the processes it started, theirs included', async () => {
    const shell = Bun.spawn(['sh', '-c', 'sh -c "sleep 30; true" & sleep 30 & wait'])

    try {
      let tree: number[] = []

      for (let tries = 0; tries < 100 && tree.length < 4; tries++) {
        await Bun.sleep(10)
        tree = processTree(shell.pid)
      }

      expect(tree[0]).toBe(shell.pid)
      expect(tree.length).toBe(4)
      expect(treeMemory(shell.pid).processes).toBe(4)
      expect(treeMemory(shell.pid).pss).toBeGreaterThan(0)
    }
    finally {
      for (const pid of processTree(shell.pid).toReversed())
        process.kill(pid, 'SIGKILL')
      await shell.exited
    }
  })
})
