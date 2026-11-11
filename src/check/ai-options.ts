import type { CheckDiagnostic, CheckOptions } from '.'
import { renamedCallOptions } from './renamed-call-options'

const ASK = /\bask\b/

// `reasoning` and `confirm` in the options of kayjs-ai's `ask()`, `effort` and `approval` since 1.99: `reasoning` also named the model's thinking in Chat, and `confirm` the call's approval Chat asks of the visitor.
// Found in the options object written as the second argument of a call of `ask` imported from `@kaynooo/kayjs-ai`; a key whose new name is written too is reported with no fix.
export async function aiOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedCallOptions(root, options, {
    lint: 'deprecated-ai-options',
    needle: ASK,
    from: source => source === '@kaynooo/kayjs-ai',
    calls: { ask: 1 },
    renames: [['reasoning', 'effort'], ['confirm', 'approval']],
    since: '1.99',
    of: 'kayjs-ai\'s `ask()`',
  })
}
