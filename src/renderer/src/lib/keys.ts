/**
 * Keyboard helpers shared by the chat box and the dialogs.
 */

/**
 * True while an input method is still assembling a character. Chinese, Japanese and Korean input
 * methods use Enter, the arrows, Escape and Space to choose among the candidates they offer, and
 * those key presses reach the page like any other. Acting on them sends half-typed pinyin as a
 * message or steals the arrow keys from the candidate list, so every handler that reads such a key
 * has to let it through while the composition is open.
 */
export function isComposing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const native: KeyboardEvent = 'nativeEvent' in e ? e.nativeEvent : e
  // keyCode 229 is what the browser reports for a key that belongs to the input method.
  return native.isComposing || native.keyCode === 229
}
