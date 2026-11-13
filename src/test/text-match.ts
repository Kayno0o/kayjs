// Both functions cross into the page as their source, so they read nothing from this module.

// Whether an element `css` matches holds `text`, the spaces kay's French typography writes (U+00A0, U+202F) read as plain ones in the page and in `text`.
export function textFound(css: string, text?: string): boolean {
  const plain = (value: string) => value.replace(/[\xA0\u202F]/g, ' ')

  return [...document.querySelectorAll(css)].some(element => text === undefined || plain(element.textContent ?? '').includes(plain(text)))
}

// The same with every other whitespace run (a thin space, a line break) one space, for the message of a wait that timed out.
export function textHeldUpToWhitespace(css: string, text: string): boolean {
  const squashed = (value: string) => value.replace(/\s+/g, ' ').trim()

  return [...document.querySelectorAll(css)].some(element => squashed(element.textContent ?? '').includes(squashed(text)))
}

// Waits for an element `selector` matches, holding `wait.text` when given, or for none to; a timeout on text says so when an element holds it up to its whitespace, which prints as the plain spaces the wait used.
export async function waitForText({ poll, inView, selector, wait, timeout }: {
  poll: (expression: string, wanted: string, wait?: number) => Promise<void>
  inView: <T>(expression: string) => Promise<T>
  selector: string
  wait: { text?: string | undefined, gone?: boolean | undefined }
  timeout: number | undefined
}): Promise<void> {
  const found = `(${textFound.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(wait.text)})`
  const wanted = `${selector}${wait.text === undefined ? '' : ` with text "${wait.text}"`}${wait.gone ? ' to be gone' : ''}`

  try {
    await poll(wait.gone ? `!${found}` : found, wanted, timeout)
  }
  catch (error) {
    if (wait.text === undefined || wait.gone || !(error instanceof Error))
      throw error

    let held = false

    try {
      held = await inView<boolean>(`(${textHeldUpToWhitespace.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(wait.text)})`)
    }
    catch {}

    throw held ? new Error(`${error.message}; an element holds the text up to its whitespace, which differs from the plain spaces waited for (a thin or other special space, a line break)`, { cause: error.cause }) : error
  }
}
