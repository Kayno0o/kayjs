const MAX_WORDS = 200
// A code is one word with an underscore, or digits: `NOT_FOUND`, `404`. A short all-caps message such as `ACCESS DENIED` or `FULL` is still a message.
const CODE = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$|^\d+$/

// The words of a route's answer or an action's `ctx.fail` data, as `refusal()` in kay's runtime reads them, kept only when they read as a message: not markup from a proxy, a status code, several lines or a page.
export function answerMessage(answer: unknown): string | undefined {
  const text = typeof answer === 'object' && answer !== null && !(answer instanceof Blob) ? fieldMessage(answer) : answer

  if (typeof text !== 'string')
    return undefined

  const words = text.trim()

  return words === '' || words.length > MAX_WORDS || words.startsWith('<') || words.includes('\n') || CODE.test(words) ? undefined : words
}

// The string `message` of a JSON answer, else its string `error`.
function fieldMessage(answer: object): unknown {
  if ('message' in answer && typeof answer.message === 'string')
    return answer.message

  return 'error' in answer ? answer.error : undefined
}
