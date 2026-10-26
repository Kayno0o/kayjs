// Polls a condition until it holds, for state that no event or promise of the code under test announces; the assertion that follows checks the same condition, so a timeout leaves it to fail there with its own message.
export async function untilHolds(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!await condition() && Date.now() < deadline)
    await Bun.sleep(2)
}
