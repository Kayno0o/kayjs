// Cuts a Markdown body into parts a model can translate one request at a time, joined back they are the body byte for byte.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/

interface Block {
  text: string
  // A code fence is never cut, whatever its length.
  fenced: boolean
}

// The text as blocks ending at the blank lines that follow them, outside code fences.
function blocks(text: string): Block[] {
  const found: Block[] = []
  let current = ''
  let fenced = false
  let fence: string | undefined
  let blank = false

  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const isBlank = line.trim() === ''

    if (blank && !isBlank && fence === undefined) {
      found.push({ text: current, fenced })
      current = ''
      fenced = false
    }

    current += line
    blank = isBlank && fence === undefined

    const marker = FENCE_LINE.exec(line)?.[1]

    if (marker === undefined)
      continue

    fenced = true

    if (fence === undefined)
      fence = marker
    else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker)
      fence = undefined
  }

  if (current !== '')
    found.push({ text: current, fenced })

  return found
}

// A block past the limit, cut after whole lines; a line past it stays one part.
function byLines(text: string, limit: number): string[] {
  const parts: string[] = []
  let current = ''

  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    // A blank line goes with the line before it, so no part is only white space.
    if (current !== '' && line.trim() !== '' && current.length + line.length > limit) {
      parts.push(current)
      current = ''
    }

    current += line
  }

  return current === '' ? parts : [...parts, current]
}

export function splitMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit)
    return [text]

  const parts: string[] = []
  let current = ''

  for (const block of blocks(text)) {
    if (current !== '' && current.length + block.text.length > limit) {
      parts.push(current)
      current = ''
    }

    if (block.text.length > limit && !block.fenced) {
      parts.push(...byLines(block.text, limit))

      continue
    }

    current += block.text
  }

  return current === '' ? parts : [...parts, current]
}
