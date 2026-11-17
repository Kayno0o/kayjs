import type { Node, SnippetNode, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { someNode } from './ast'

const CALL = /^\s*([a-z_$][\w$]*)\s*\(/i

// The form each function of a template was called in, for the `error` and `pending` lines outside every form of their file: the template's own function and each snippet holding such a line capture it once as they are called, as a line may be created again long after the render that knew the form.
export class FormHere {
  private readonly names = ['KayHere']
  private readonly snippets = new Set<string>()
  private count = 0

  // The name holding the form of the function being written.
  get current(): string {
    return this.names.at(-1)!
  }

  // The action a line follows: the form around it in the file, else the one its function was called in.
  target(b: CodeBuilder, form: Span | undefined): void {
    if (form)
      b.add('(').addSource(form).add(')')
    else
      b.add(this.current)
  }

  // An expression inserted: a call of a snippet in a form is built inside the form's scope, as the component called there is, for its `error` and `pending` lines to follow it.
  expression(b: CodeBuilder, expression: Span, src: string, form: Span | undefined, scoping: string): void {
    const name = CALL.exec(src.slice(expression.start, expression.end))?.[1]
    const scoped = form !== undefined && name !== undefined && this.snippets.has(name)

    if (scoped)
      b.add(`${scoping}((`).addSource(form).add('), () => ')

    b.add('(').addSource(expression).add(scoped ? '))' : ')')
  }

  // Writes a snippet taking the form it is called in, falling back to the one of the function around it for a call made after the render; false for one with no such line, which is left to write.
  declare(b: CodeBuilder, node: SnippetNode, name: string, forms: ReadonlyMap<Node, Span>, helper: string, children: () => void): boolean {
    this.snippets.add(name)

    if (!someNode(node.children, line => (line.kind === 'error' || line.kind === 'pending') && !forms.has(line)))
      return false

    const own = `KayHere${++this.count}`

    b.wrap(node, () => {
      b.add('const ').addSource(node.name).add(' = (').addSource(node.params).add(`) => { const ${own} = ${helper}() ?? ${this.current}; return `)
      this.names.push(own)
      children()
      this.names.pop()
      b.add('; }; ')
    })

    return true
  }
}
