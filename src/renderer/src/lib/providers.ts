import type { ProviderView } from '@shared/types'
import type { PopupOption } from '@/components/common/PopupSelect'
import { modelLabel } from './format'

const SEP = '::'

/** Value of a model-picker option: "provider::model" for another provider, the bare model id for Anthropic. */
export function encodeModelChoice(provider: string | undefined, model: string): string {
  return provider && provider !== 'anthropic' ? `${provider}${SEP}${model}` : model
}

export function decodeModelChoice(value: string): { provider?: string; model: string } {
  const i = value.indexOf(SEP)
  return i > 0 ? { provider: value.slice(0, i), model: value.slice(i + SEP.length) } : { model: value }
}

/**
 * Name of a model for the closed control: written the same way as everywhere else. The launchers
 * label their own models, but in their own styles (Codex wrote "GPT-6-Astra" next to "gpt-5.2",
 * DeepSeek and Kimi wrote raw ids), so the app's own spelling is used for every provider.
 */
export function providerModelLabel(model: string | undefined): string {
  return modelLabel(model)
}

/** Picker options for every other provider: a heading per provider, then its models (or why it is unavailable). */
export function providerModelOptions(providers: ProviderView[]): PopupOption[] {
  const out: PopupOption[] = []
  for (const p of providers) {
    const via = p.staleEnv ? ` — its launcher refused, so the settings it produced on ${new Date(p.staleEnv.at).toLocaleString()} are used` : ''
    out.push({ value: `heading:${p.id}`, label: p.name, heading: true, hint: `Runs "${p.launcher}" from your shell${via}` })
    if (!p.available) {
      out.push({ value: `unavailable:${p.id}`, label: `Not available: ${p.reason ?? 'unknown reason'}`, disabled: true })
      continue
    }
    for (const m of p.models) {
      // The closed control shows the name on its own; inside the list the id follows in brackets, and
      // that id already says "[1m]", so the window marker is not repeated.
      const name = modelLabel(m.value).replace(/ \(1M\)$/, '')
      // A parenthetical in the launcher's own label says something the id does not ("what cc-ds uses
      // by itself"), so it is kept as a note rather than lost with the rest of the launcher's wording.
      const note = m.label.includes('(') ? m.label.slice(m.label.indexOf('(')).trim() : ''
      const hint = [note, m.unavailable ?? m.description].filter(Boolean).join('\n') || undefined
      out.push({ value: encodeModelChoice(p.id, m.value), label: `${name} (${m.value})`, short: name, hint, disabled: Boolean(m.unavailable) })
    }
    if (p.reason) out.push({ value: `note:${p.id}`, label: p.reason, disabled: true })
  }
  return out
}
