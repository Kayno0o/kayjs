# Task 04: Authenticated Notes CRUD with SQLite & UI

Build an authenticated personal notes app using `@kayjs/auth`, `@kayjs/ui`, and `bun:sqlite`.

## Requirements

1. **Authentication (`src/auth.ts` & `kay.config.ts`)**:
   - Create `auth = createAuth({ store: sqliteAuthStore(dbPath), requireEmailVerification: false, secret: process.env.AUTH_SECRET ?? 'dev-auth-secret-at-least-32-bytes-long!' })` using `sqliteAuthStore` from `@kayjs/auth/sqlite`.
   - Use a configurable DB path (e.g. `process.env.NOTES_DB ?? './data/app.sqlite'`, ensuring the parent directory exists before opening SQLite).
   - Register both `ui({ grammar: 'editorial' })` (from `@kayjs/ui/plugin`) and `auth` in `kay.config.ts`.

2. **SQLite Notes Store (`src/db.ts`)**:
   - Use `Database` from `bun:sqlite` to create a `notes(id, user_id, title, body, created_at)` table.
   - Provide user-scoped CRUD helpers (`listNotes(userId)`, `createNote(userId, title, body)`, `deleteNote(userId, id)`).

3. **Routes & Guard**:
   - `src/routes/login.tsx` and `src/routes/signup.tsx`: Accessible `@kayjs/ui` forms posting to `/auth/signin` and `/auth/signup`.
   - `src/routes/notes/_middleware.ts`: Protect `/notes` with `export default auth.guard({ redirectTo: '/login' })`.
   - `src/routes/notes/index.tsx`: Server-rendered notes list for `locals.user`, a create-note `<form method="post">` backed by a Kay `action()` accepting `title` and `body` fields, delete buttons backed by an `action()`, and a sign-out button posting to `/auth/signout`.
   - Protect create/delete note actions via `src/routes/notes/_actions.ts` or by checking `ctx.locals.user` (returning `ctx.deny(401, 'Unauthorized')` if unauthenticated).

4. **Automated Tests (`tests/notes.test.ts`)**:
   - Use `testApp({ root: '.' })` to test: unauthenticated redirect from `/notes` to `/login`, signup, creating a note, listing the note, and signing out.

5. **Verification**:
   - `kay check`, `kay build --analyze --max-js 20kb`, and `bun test` all pass.
