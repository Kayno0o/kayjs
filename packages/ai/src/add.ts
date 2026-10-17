// What `kay add ai` writes: the extension, no file.
export default {
  description: 'ask(): an LLM called with no SDK, streaming into await blocks and actions, answered by a scripted fake in development and tests',
  extension: { import: 'import { ai } from \'@kaynooo/kayjs-ai\'', expression: 'ai()' },
  notes: ['Set AI_MODEL and ANTHROPIC_API_KEY, OPENAI_API_KEY or AI_BASE_URL (Ollama) in production; development and tests answer from a fake until then.'],
}
