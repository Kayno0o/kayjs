import type { Node, SnippetNode, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { someNode } from './ast'
import { helperName } from './markup'

const CALLED = /[a-z_$][\w$]*(?=\s*\()/gi

// The form each function of a template was called in, for the `error` and `pending` lines outside every form of their file: the template's own function and each block of content holding such a line (a snippet, the children a component is given) capture it once as it is called, as a line may be created again long after the render that knew the form.
export class FormHere {
  private readonly names = ['KayHere']
  private readonly snippets = new Set<string>()
  private count = 0

  // The name holding the form of the function being written.
  get current(): string {
    return this.names.at(-1)!
  }

  // Names a snippet, so a call of it inside a form is built in the form's scope.
  declared(snippet: SnippetNode, src: string): SnippetNode {
    this.snippets.add(src.slice(snippet.name.start, snippet.name.end))

    return snippet
  }

  // The action a line follows: the form around it in the file, else the one its function was called in.
  target(b: CodeBuilder, form: Span | undefined): void {
    if (form)
      b.add('(').addSource(form).add(')')
    else
      b.add(this.current)
  }

  // Opens the scope a component's script runs in, the action of the form around it in the file; false when it has none.
  scope(b: CodeBuilder, form: Span | undefined): boolean {
    if (!form)
      return false

    b.add(`${helperName('issueScope')}(`)
    this.target(b, form)
    b.add(', () => ')

    return true
  }

  // An expression inserted: one calling a snippet in a form is built inside the form's scope, as the component called there is, for its `error` and `pending` lines to follow it.
  expression(b: CodeBuilder, expression: Span, src: string, form: Span | undefined): void {
    const scoped = form !== undefined && src.slice(expression.start, expression.end).match(CALLED)?.some(name => this.snippets.has(name)) === true

    if (scoped)
      this.scope(b, form)

    b.add('(').addSource(expression).add(scoped ? '))' : ')')
  }

  // Writes a block of content, taking the form it is called in when it holds a line following one, falling back to the one of the function around it for a call made after the render.
  within(b: CodeBuilder, nodes: Node[], forms: ReadonlyMap<Node, Span>, children: () => void): void {
    if (!someNode(nodes, line => (line.kind === 'error' || line.kind === 'pending') && !forms.has(line))) {
      children()

      return
    }

    const own = `KayHere${++this.count}`

    b.add(`(() => { const ${own} = ${helperName('formHere')}() ?? ${this.current}; return `)
    this.names.push(own)
    children()
    this.names.pop()
    b.add('; })()')
  }
}
