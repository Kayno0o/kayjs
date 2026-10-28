# kayjs-ai: Personal data and the AI notice

kayjs-ai sends what a visitor writes to an AI provider, so the site that runs it answers for that under the GDPR. kay's own cookies and data are in [Privacy and personal data](../../../llms/privacy.md).

## Common tasks

### Telling the visitor it is an AI

The AI Act (art. 50(1)) wants a person told they are talking to an AI unless it is obvious. `Chat` and `ChatLauncher` show a line under the log: `You are talking to an AI. Your messages are sent to its provider to answer.` It is the `ai.chat.disclosure` message, so a catalog under `ai: { chat: { disclosure } }` in `src/messages/<locale>.ts` words it for each locale ([Locales](../../../llms/locales.md)), and the `disclosure` prop overrides it for one chat, such as to name the provider; `disclosure=""` hides it, for a page that says so itself.

A chat of your own, built on `ask` without `Chat`, shows its own notice. Say where the messages go too, and link the privacy notice from it.


## Reference

### What leaves the server

- Every `ask` sends the provider the system prompt, the messages and, with `tools`, each tool's name, description, schema and the result of every call, which is whatever the action returned. `Chat` posts the whole conversation (the latest `keep` messages) on every send, so a message stays in the provider's hands for as long as the conversation runs.
- The provider is Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`) or the server `AI_BASE_URL` names. Anthropic and OpenAI are US companies: sending a visitor's text to them is a transfer outside the EU (GDPR art. 44), which needs its basis (the provider's DPA with its standard contractual clauses, or the EU-US Data Privacy Framework). A server of your own such as Ollama keeps the text on your infrastructure.
- The site is the controller and the provider its processor: sign the provider's data processing agreement, check what it keeps and for how long (its API terms, not its consumer app's), and name the provider, the purpose and the transfer in the privacy notice shown at collection (art. 13). A visitor writing health, political or other special-category data to a chat is not something the library can filter.
- Keep personal data out of what the model reads that it need not: a tool's result goes to the provider as it is, so an action offered as a tool returns only the fields the answer needs, and the system prompt names no one.

### What kayjs-ai keeps

- Nothing of the messages or replies, unless a `Chat` has `keepOnServer` or `conversations`: it writes no log of them and no file. An error in the app's log names the failure, not the text.
- With `keepOnServer` or `conversations`, the text of each turn, the sources a reply cited and the conversation's title, under the visitor's user id (or the `key` naming them), in `data/ai-conversations.sqlite` or the store given to `ai({ conversations })`, until the visitor deletes the conversation or it is pruned past their 200 latest. Erasing a user's data (art. 17) deletes their rows: `DELETE FROM kai_conversations WHERE owner = ?` on the default file. Name the purpose and the time kept in the privacy notice ([Conversations kept on the server](chat-conversations.md)).
- The limits count per visitor under a key that is the signed-in user's id, else the visitor's address (one key per IPv6 /64), in this process's memory or in the `store` you give, for the length of the window. That address or id is personal data: a `sqliteRates` file holds it until the window ends, and a store of your own for as long as it keeps it.
- `ChatLauncher` and `Chat` keep the conversation in the tab's session storage only when `remember` names a key ([Chat island](chat.md)). A `ChatLauncher` with `keepOnServer` or `conversations` keeps the id of the conversation it shows in localStorage, under `kai-chat-conversation:` and the action's URL, which reads nothing without the visitor's session.
- `kay i18n translate` sends the app's own messages and entries to the provider, not a visitor's.
