import { Zap } from 'lucide-react'
import type { ProviderView, SessionLiveState, SessionRecord } from '@shared/types'
import { claudeModelHasFastMode, fastModeReasonText } from '@shared/fastMode'
import { modelLabel } from '@/lib/format'
import { providerFastVariant } from '@/lib/providers'

/**
 * The chat's fast mode switch, next to model, permissions and effort: one click turns it on or off,
 * and it is amber while on, since fast mode costs more. On a Claude model it is Claude Code's own
 * fast mode; on a GPT model the bridge's fast variant of that model runs in its place, so the model
 * keeps its name. On a model without fast mode the switch is dimmed and can only be turned off: the
 * chat keeps it on, as Claude Code does, for the next model that has fast mode.
 */
export function FastSwitch({ record, live, providers, onError }: { record: SessionRecord; live: SessionLiveState | undefined; providers: ProviderView[]; onError: (err: unknown) => void }) {
  const on = record.fastMode === true
  const claude = !record.provider
  const modelId = claude ? live?.model || record.model || record.lastModel : record.model
  const name = modelId ? modelLabel(modelId) : 'The default model'
  // Whether the chat's model has fast mode; undefined while that is not known yet (no model list).
  let capable: boolean | undefined
  let what: string
  if (claude) {
    // Claude Code's own list says it per model; otherwise its rule for model ids does.
    const listed = live?.models?.find((m) => m.value === record.model || m.value === modelId)
    capable = listed ? listed.supportsFastMode === true : modelId ? claudeModelHasFastMode(modelId) : undefined
    what = "the same model answers faster, paid from usage credits rather than your plan's included usage."
  } else {
    const provider = providers.find((p) => p.id === record.provider)
    const variant = providerFastVariant(provider, record.model)
    capable = provider?.available ? Boolean(variant) : undefined
    what = variant
      ? `${name} runs as ${variant.value}, the bridge's fast version of it${variant.description ? ` (Codex: "${variant.description}")` : ''}.`
      : `${name} runs as the bridge's fast version of it.`
  }
  // What Claude Code itself last said about fast mode in this chat, when it is not using it.
  const blocked = on && claude && capable !== false && live?.fastModeState !== undefined && live.fastModeState !== 'on'
  const blockedWhy = live?.fastModeState === 'cooldown'
    ? 'Claude Code paused it after reaching the fast mode rate limit; turns run at standard speed until the pause ends.'
    : fastModeReasonText(live?.fastModeReason) ?? 'Claude Code reports it as off.'

  const lines: string[] = []
  if (capable === false) {
    lines.push(`${name} has no fast mode${claude ? ' (Claude Code offers it for Opus 4.8 and the Opus 5 models)' : ''}, so this chat runs at standard speed.`)
    if (on) lines.push('The switch stays on for this chat and applies again on a model that has fast mode. Click to switch it off.')
  } else {
    lines.push(on ? `Fast mode is on for this chat: ${what}` : `Fast mode is off. Click to switch it on for this chat: ${what}`)
    if (on) lines.push('Click to go back to standard speed.')
    if (claude) lines.push('A change made while Claude is working applies from its next turn.')
    if (blocked) lines.push(`Claude Code is not using it right now: ${blockedWhy}`)
  }

  return (
    <button
      className={`popup-select fast-switch no-drag ${on ? 'on' : ''} ${blocked ? 'blocked' : ''} ${capable === false ? 'na' : ''}`}
      aria-pressed={on}
      disabled={capable === false && !on}
      data-tip={lines.join('\n')}
      // A click leaves the keyboard in the input box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => window.api.sessions.setFastMode(record.id, !on).catch(onError)}
    >
      <Zap size={12} className="fs-mark" fill={on ? 'currentColor' : 'none'} />
      <span className="ps-label">fast</span>
      <span className="ps-value">{on ? 'ON' : 'off'}</span>
    </button>
  )
}
