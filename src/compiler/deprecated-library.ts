import type { Details, ElementNode, Span } from './ast'
import type { LintName } from './lints'
import { deprecatedUiProps } from './deprecated-ui-props'

// The deprecated forms of a kayjs-ui or kayjs-ai component found on an element bound to the library's `file`, each reported under its own lint.
export function deprecatedLibrary(element: ElementNode, file: string, text: (span: Span) => string, lint: (span: Span, code: LintName, message: string, details: Details) => void): void {
  deprecatedUiProps(element, file, text, (span, message, details) => lint(span, 'deprecated-ui-props', message, details))
}
