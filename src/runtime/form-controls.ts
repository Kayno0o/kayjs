// Read through the prototype's getter, as a control named `elements` takes the place of `form.elements` on the form itself.
export function controlsOf(form: HTMLFormElement): HTMLFormControlsCollection {
  return Reflect.get(HTMLFormElement.prototype, 'elements', form)
}
