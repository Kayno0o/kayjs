import { auth } from '../../../src/auth'

// The fixture's guard on a site replacing none of kayjs-auth's pages, so the ones served under it are kayjs-auth's own.
export default auth.guard()
