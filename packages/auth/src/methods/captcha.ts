import type { CaptchaAction } from '../captcha'
import type { RequestState } from '../state'
import { captchaChallenge, captchaRequired } from '../captcha'

// `auth.captcha`: what a page needs to show the CAPTCHA a client's next action asks for.
export class CaptchaMethods {
  constructor(private readonly state: RequestState) {}

  // Whether this client's next `action` needs a CAPTCHA token, for the page to show the widget.
  async required(action: CaptchaAction): Promise<boolean> {
    return captchaRequired(this.state, action)
  }

  // The proof-of-work challenge for this client's next `action`, for a form field kay's script posts the solution of; null when none is needed.
  async challenge(action: CaptchaAction): Promise<string | null> {
    return captchaChallenge(this.state, action)
  }
}
