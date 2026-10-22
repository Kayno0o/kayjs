import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

type Navigation = typeof import('../src/runtime/navigation')
type Leave = typeof import('../src/runtime/leave')
type Reactive = typeof import('../src/runtime/reactive')

let navigation: Navigation
let leave: Leave
let reactive: Reactive
const questions: string[] = []
let answer = false

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/form' })
  ;(globalThis as { confirm: (message: string) => boolean }).confirm = (message) => {
    questions.push(message)

    return answer
  }
  navigation = await import('../src/runtime/navigation')
  leave = await import('../src/runtime/leave')
  reactive = await import('../src/runtime/reactive')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const TO = new URL('http://localhost/second')

// Guards the island registers, and the function that takes them away again.
function guard(dirty: () => boolean, options?: Parameters<Leave['guardLeave']>[1]): () => void {
  return reactive.root((dispose) => {
    leave.guardLeave(dirty, options)

    return dispose
  })
}

const QUESTION = 'This page has unsaved changes. Leave it anyway?'

describe('the leave guard', () => {
  it('asks the browser\'s question when the guard has no confirm of its own, and follows the answer', async () => {
    const dispose = guard(() => true)

    questions.length = 0
    answer = false
    expect(await navigation.mayLeave(TO)).toBe(false)
    answer = true
    expect(await navigation.mayLeave(TO)).toBe(true)
    expect(questions).toEqual([QUESTION, QUESTION])
    dispose()
    expect(navigation.leaveGuards.size).toBe(0)
  })

  it.each([[false], [true]])('uses the app\'s own confirm, sync or async, answering %p, without the browser\'s question', async (result) => {
    const asked: string[] = []

    const sync = (to: URL) => {
      asked.push(to.pathname)

      return result
    }

    for (const confirm of [sync, async (to: URL) => sync(to)]) {
      const dispose = guard(() => true, { confirm })

      questions.length = 0
      expect(await navigation.mayLeave(TO)).toBe(result)
      expect(questions).toEqual([])
      dispose()
    }

    expect(asked).toEqual(['/second', '/second'])
  })

  it('lets the page go with no question while no guard holds changes', async () => {
    const dispose = guard(() => false)

    questions.length = 0
    expect(await navigation.mayLeave(TO)).toBe(true)
    expect(questions).toEqual([])
    dispose()
  })
})
