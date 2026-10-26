// One turn of the event loop, which runs every microtask the code under test queued: a turn takes no time, so it paces nothing, and it is also how a test lets "nothing happens" be seen.
export const turn = async (): Promise<void> => Bun.sleep(0)

// Retries an assertion until it holds, for what the code reaches through a fetch or a stream it reads, which takes more than one turn; the last failure is the one thrown.
export async function eventually(assertion: () => void | Promise<void>, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout

  for (;;) {
    try {
      await assertion()

      return
    }
    catch (failure) {
      if (Date.now() > end)
        throw failure

      await Bun.sleep(5)
    }
  }
}
