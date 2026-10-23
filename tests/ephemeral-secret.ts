// A production server started by a test has no secret to read, and refuses to start without one unless an ephemeral key is asked for; a test of the refusal removes this from its child's environment.
process.env.KAY_EPHEMERAL_SECRET ??= '1'
