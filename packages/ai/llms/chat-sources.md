# Chat sources

## Common tasks

### Cite the documents a reply draws on

A reply grounded in documents cites them as `[1]`, `[2]`. Hand `ask` the documents and `Chat` links the citations, so the app rewrites no markdown.

```ts
return ask(messages, { sources: found.map((doc, index) => ({ n: index + 1, title: doc.title, href: doc.url })) }).progress()
```

## Reference

- `Source` is `{ n: number, title: string, href: string }`. `ask({ sources })` puts the list on every snapshot of `reply.progress()` as `sources`, so return `.progress()`: a plain `ask(...)` stream carries no sources. Tell the model to cite by number in `system`.
- The chat turns each `[n]` outside code and links in the reply into a link to the source with that `n`, and lists the cited sources, once each in the order first cited, under the turn (`div.kai-chat-sources`, a `small` label and an `ol` of `a.kai-chat-source-link`). A number with no source, and `[n]` in code, stay text. A source never cited is not listed.
- A link opens in a new tab like the reply's own, except a path of this site or an anchor when `links="here"`. The list's label is `sourcesLabel` (`Sources`, `ai.chat.sources`). Its parts, in `@kaynooo/kayjs-ai/chat-sources.kay`, are `root`, `label`, `list`, `item` and `link`.
- A source whose `href` is not `http(s)`, a path of this site, an anchor or `mailto:`, has a space, quote, backslash or angle bracket (percent-encode them), whose `n` is not an integer or that repeats a number is dropped by the chat, so a hostile page cannot slip a `javascript:` address in.
- The sources of a turn are kept by `remember` with its text. `initial` takes `sources` on an assistant message: `initial={[{ role: 'assistant', content: 'See [1].', sources: [...] }]}`. `ask` ignores `sources` on a message it is given.
