import { auth } from '../auth'

// Every page asks for a session, as on a site kept to its members: kayjs-auth's sign-in pages still open, and the app's own open ones say so.
export default auth.guard()
