// Runs an app's callback so a throw, or a rejection of the promise it returns, is logged under `label` and goes no further.
// The same shape as kayjs-ui's `safely`, kept here as kayjs-ui is an optional peer.
export function safely(call: () => unknown, label: string): void {
  try {
    const result = call()

    if (result instanceof Promise)
      void settled(result, label)
  }
  catch (error) {
    console.error(`${label} threw`, error)
  }
}

async function settled(pending: Promise<unknown>, label: string): Promise<void> {
  try {
    await pending
  }
  catch (error) {
    console.error(`${label} rejected`, error)
  }
}
