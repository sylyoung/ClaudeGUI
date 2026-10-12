/**
 * Fast mode: the same model answering faster, at a higher price. Claude Code has it for Claude
 * models (its /fast); the Codex bridge offers it for GPT models as a model id of its own,
 * "<model>-fast". In the app it is one switch per chat for both, so a GPT chat keeps its model's
 * name and the bridge's fast id is only what Claude Code is given to run.
 */

/** "gpt-6.1-sol[1m]" → "gpt-6.1-sol-fast[1m]": the id the Codex bridge gives a model's fast variant. */
export function fastModelId(model: string): string {
  const long = /\[1m\]$/.test(model)
  return `${model.replace(/\[1m\]$/, '')}-fast${long ? '[1m]' : ''}`
}

/** The model a fast id is the variant of ("gpt-6.1-sol-fast[1m]" → "gpt-6.1-sol[1m]"), or null. */
export function fastModelBase(model: string): string | null {
  const m = /^(.+)-fast(\[1m\])?$/.exec(model)
  return m ? m[1] + (m[2] ?? '') : null
}

/**
 * Whether Claude Code offers fast mode for a Claude model, by its own rule (the bundled CLI checks
 * for "opus-4-8" and "opus-5" in the model id; its model list can say otherwise per model, and that
 * answer is preferred where the app has it).
 */
export function claudeModelHasFastMode(model: string | undefined): boolean {
  const m = (model ?? '').toLowerCase()
  return m.includes('opus-4-8') || m.includes('opus-5')
}

/**
 * Why Claude Code is not using fast mode, in its own words where it has them (its reasons are the
 * `fast_mode_disabled_reason` of the SDK's messages).
 */
export function fastModeReasonText(reason: string | undefined): string | undefined {
  switch (reason) {
    case undefined:
      return undefined
    case 'free':
      return 'Fast mode requires a paid subscription.'
    case 'preference':
      return 'Fast mode has been disabled by your organization.'
    case 'extra_usage_disabled':
      return 'Fast mode requires usage credits, and they are not turned on for your account.'
    case 'network_error':
      return 'Fast mode unavailable due to network connectivity issues.'
    case 'not_first_party':
      return 'Fast mode is only available when using the Anthropic API directly.'
    case 'disabled_by_env':
      return 'Fast mode is turned off by CLAUDE_CODE_DISABLE_FAST_MODE in the environment.'
    case 'model_not_allowed':
      return 'This model has no fast mode.'
    case 'sdk_opt_in_required':
      return 'Claude Code did not get the app\'s request for fast mode yet.'
    case 'pending':
      return 'Claude Code is still checking whether fast mode is available.'
    default:
      return 'Fast mode is currently unavailable.'
  }
}
