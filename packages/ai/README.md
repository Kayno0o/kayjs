# kayjs-ai

An LLM called from kay apps with no SDK and no streaming code: `ask()` over Anthropic or any OpenAI-compatible server (OpenAI, Ollama) through their HTTP APIs, a reply that streams into `await` blocks and into streaming actions as it is, and a scripted fake answering in development and tests.

## Install

kayjs-ai is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml` (a project made by `kay new` already carries it in its `.npmrc`):

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-ai
```

kay is a peer. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together.

## Use

Set `AI_MODEL` and one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `AI_BASE_URL` (Ollama), then:

```kay
--- server
import { ask } from '@kaynooo/kayjs-ai'

const answer = ask('Say hello')
---
await answer
  p Thinking
then text
  p {text}
```

Without a provider configured, development and `bun test` answer from a fake a test scripts with `fakeAi.reply()`. The full reference is [llms.txt](llms.txt).
