import type { CodeBuilder } from './mapping'

// Static parts gather into one string literal; each dynamic part is an expression of the markup it renders.
export class Markup {
  private pending = ''
  private parts = 0

  constructor(private readonly b: CodeBuilder) {}

  text(text: string): void {
    this.pending += text
  }

  dynamic(emit: () => void): void {
    this.flush()
    this.separate()
    emit()
  }

  end(): void {
    this.flush()

    if (this.parts === 0)
      this.b.add('""')
  }

  private flush(): void {
    if (this.pending === '')
      return

    this.separate()
    this.b.add(JSON.stringify(this.pending))
    this.pending = ''
  }

  private separate(): void {
    if (this.parts++ > 0)
      this.b.add(' + ')
  }
}
