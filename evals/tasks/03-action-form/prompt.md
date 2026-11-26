# Task 03: Progressive Server Action Form & Flash Fallback

Build a contact/feedback submission page at `/` backed by a typed Kay server `action()` that works both with JS (`useAction()`) and without JS (progressive `<form method="post">` + `getActionError()` flash redirect).

## Requirements

1. **Server Action (`src/actions/feedback.ts`)**:
   - Export a top-level named `action(schema, handler)` (e.g. `export const submitFeedback = action(...)`).
   - Validate `{ name, email, message }` with a Standard Schema v1 schema:
     - `name`: non-empty string, at least 2 characters
     - `email`: valid email address containing `@` and `.`
     - `message`: string, at least 10 characters
   - On success, return `{ id, name, email, receivedAt }`.

2. **Progressive Form Island (`src/components/FeedbackForm.tsx`)**:
   - Use `useAction(submitFeedback, { reset: true })` from `@kayjs/kay`.
   - Wire `<form action={form.action} method="post" onSubmit={form.onSubmit}>` with inputs named `name`, `email`, and `message`.
   - Accept optional server flash error props (`serverError?: string`, `serverFieldErrors?: Record<string, string>`) so errors from zero-JS form submissions render on reload too.
   - Show field-level errors (`role="alert"`) and a confirmation message on success.

3. **Route (`src/routes/index.tsx`)**:
   - Read `getActionError(ctx.locals)` inside `load(ctx)` (or pass from `locals`) so a zero-JS `POST` with invalid fields that triggers Kay's `303` flash redirect displays the error on `GET /`.
   - Render `<FeedbackForm>` with the flash error/fieldErrors props.

4. **Automated Tests (`tests/feedback.test.ts`)**:
   - Write at least 2 tests using `testApp({ root: '.' })` from `@kayjs/kay/test` covering invalid submission (field errors) and valid submission (`ok: true`).

5. **Verification**:
   - `kay check`, `kay build --analyze --max-js 15kb`, and `bun test` all pass.
