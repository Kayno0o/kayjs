import { auth } from '../../auth'

// The partner's pages call this module with the user's cookies, which the guard reads as on any request.
export default auth.guard()
