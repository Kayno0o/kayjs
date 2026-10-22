import { blockIn, islandOf, Region, release, swap } from './dom'
import { getOwner, onCleanup, renderEffect, reportError, runWithOwner, unrecorded, untrack } from './reactive'
import { isSnapshots, readSnapshots } from './snapshots'

// The `await` block: its own module, as it weighs on a page whose islands await nothing.

// An iterable's parts render at most this often in an island, about once a frame.
const FRAME_MS = 16

// An `await` block: the pending block while the value is a promise, then the `then` or `catch` block once it settles, or with no `catch` the enclosing `try`'s as `fallback`; a plain value renders `then` at once, and an async iterable renders `then` again with each part, at most once a frame.
export function awaited(element: Node | null, start: Node | null, end: Node | null, value: () => unknown, pending: (() => unknown) | undefined, ready: (value: unknown) => unknown, failed: ((error: unknown) => unknown) | undefined, fallback?: ((error: unknown) => unknown) | undefined): void {
  const region = new Region(element, start, end)
  const block = blockIn(region)
  let version = 0

  renderEffect(() => {
    const settled = value()
    const own = ++version

    untrack(() => {
      const parts = isSnapshots(settled)

      if (!parts && !(settled instanceof Promise)) {
        unrecorded(() => swap(block, () => ready(settled)))

        return
      }

      // Where the block was declared, for one landing later to read what was provided there.
      const parent = getOwner()

      // Gone before the promise settles, the block never lands.
      onCleanup(() => {
        version++
        release(block)
      })

      // The pending block and the block replacing it each own what they create, so landing disposes the pending one.
      unrecorded(() => swap(block, () => pending?.(), true))

      const land = (render: () => unknown) => {
        if (own === version)
          runWithOwner(parent, () => unrecorded(() => swap(block, render, true)))
      }

      // A part whose `then` block throws is a bug in the page, reported rather than shown as `catch`, and the iterable is not read further.
      let broken = false
      const reader = parts
        ? readSnapshots(settled, FRAME_MS, (value) => {
          try {
            land(() => ready(value))
          }
          catch (error) {
            broken = true
            reader!.stop()
            reportError(error)
          }
        })
        : undefined

      onCleanup(() => reader?.stop())

      // A `then` block that throws while rendering is not the promise failing, so it stays out of the catch.
      const settle = async () => {
        let result: { value: unknown, shown?: boolean } | undefined

        try {
          result = reader ? await reader.done : { value: await settled }
        }
        catch (error) {
          if (broken)
            return

          if (failed) {
            land(() => failed(error))
          }
          // The enclosing `try`'s `catch` takes the place of the block, the error reported as the `try` reports one.
          else if (fallback) {
            if (own === version)
              reportError(error, islandOf(region.parent))

            land(() => fallback(error))
          }
          else if (own === version) {
            reportError(error, islandOf(region.parent))
          }

          return
        }

        // A last part shown already stays as it is, focus and selection inside it too.
        if (broken || result?.shown === true)
          return

        // An iterable ending with no value leaves nothing in place of its pending block.
        land(result ? () => ready(result.value) : () => null)
      }

      void settle()
    })
  })
}
