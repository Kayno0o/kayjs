// Polls until the condition holds, for the event a test stood in for with a fixed sleep: it resolves as soon as it does, and fails with the timeout's name when a loaded machine never gets there.
export async function until(condition: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout

  while (!await condition()) {
    if (Date.now() > deadline)
      throw new Error(`the condition did not hold within ${timeout} ms: ${condition.toString()}`)

    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
