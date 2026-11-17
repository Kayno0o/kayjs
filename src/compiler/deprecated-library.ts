import type { Details, ElementNode, Span } from './ast'
import type { LintName } from './lints'
import { deprecatedAiLabels } from './deprecated-ai-labels'
import { deprecatedAiLinks } from './deprecated-ai-links'
import { deprecatedAuthSigned } from './deprecated-auth-signed'
import { deprecatedUiCallbacks } from './deprecated-ui-callbacks'
import { deprecatedUiInput } from './deprecated-ui-input'
import { deprecatedUiItems } from './deprecated-ui-items'
import { deprecatedUiProps } from './deprecated-ui-props'

// The deprecated forms of a kayjs-ui or kayjs-ai component found on an element bound to the library's `file`, each reported under its own lint.
export function deprecatedLibrary(element: ElementNode, file: string, text: (span: Span) => string, lint: (span: Span, code: LintName, message: string, details: Details) => void): void {
  deprecatedUiProps(element, file, text, (span, message, details) => lint(span, 'deprecated-ui-props', message, details))
  deprecatedUiCallbacks(element, file, text, (span, message, details) => lint(span, 'deprecated-ui-callbacks', message, details))
  deprecatedUiItems(element, file, text, (span, message, details) => lint(span, 'deprecated-ui-items', message, details))
  deprecatedUiInput(element, file, text, (span, message, details) => lint(span, 'deprecated-ui-input', message, details))
  deprecatedAiLabels(element, file, text, (span, message, details) => lint(span, 'deprecated-ai-labels', message, details))
  deprecatedAiLinks(element, file, text, (span, message, details) => lint(span, 'deprecated-ai-links', message, details))
  deprecatedAuthSigned(element, file, text, (span, message, details) => lint(span, 'deprecated-auth-signed', message, details))
}
