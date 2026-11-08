import type { Comment, Node } from 'oxc-parser'
import { SPACE } from './rewrite-reads'

// Reads the generated code around a node, where oxc leaves parentheses out of its span and comments may sit between.
export class Scanner {
  // Where each comment of the generated code begins and ends, which the text between a node and its parentheses may hold.
  private readonly commentEnds = new Map<number, number>()
  private readonly commentStarts = new Map<number, number>()

  constructor(private readonly code: string, comments: readonly Comment[]) {
    for (const comment of comments) {
      this.commentEnds.set(comment.end, comment.start)
      this.commentStarts.set(comment.start, comment.end)
    }
  }

  // The offsets of the opening parentheses just before `at`, the nearest first and none before `floor`: oxc leaves the parentheses of an expression out of its span, as `@babel/parser`'s `extra.parenStart` did.
  parensBefore(at: number, floor: number): number[] {
    const { code } = this
    const found: number[] = []
    let index = at

    while (true) {
      let moved = true

      while (moved) {
        moved = false

        while (index > floor && SPACE.test(code[index - 1]!))
          index--

        const start = this.commentEnds.get(index)

        if (start !== undefined && start >= floor) {
          index = start
          moved = true
        }
      }

      if (index - 1 < floor || code[index - 1] !== '(')
        return found

      found.push(index - 1)
      index--
    }
  }

  // Whether the parentheses around a node are written, as an assignment's target or an update's operand may be.
  parenthesized(node: Node): boolean {
    const { code } = this
    const before = this.parensBefore(node.start, 0)[0]

    if (before === undefined)
      return false

    let index = node.end

    while (index < code.length && (SPACE.test(code[index]!) || this.commentStarts.has(index)))
      index = this.commentStarts.get(index) ?? index + 1

    return code[index] === ')'
  }

  // Whether a comma stands between two offsets outside the comments, as before the closing parenthesis of a call.
  trailingComma(from: number, to: number): boolean {
    for (let index = from; index < to; index++) {
      const end = this.commentStarts.get(index)

      if (end !== undefined)
        index = end - 1
      else if (this.code[index] === ',')
        return true
    }

    return false
  }
}
