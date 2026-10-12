import type { ProviderModelView, ProviderView } from '@shared/types'
import type { PopupOption } from '@/components/common/PopupSelect'
import { fastModelBase, fastModelId } from '@shared/fastMode'
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

/**
 * Whether a provider model is another model's fast variant (the Codex bridge's "<model>-fast"). Those
 * are run by the chat's fast switch rather than listed as models; a session host from before the
 * switch does not mark them, so there the id says it.
 */
function isFastVariant(m: ProviderModelView, all: ProviderModelView[]): boolean {
  if (m.fastOf) return true
  const base = fastModelBase(m.value)
  return Boolean(base && all.some((o) => o.value === base))
}

/** The models a provider's lists show: all of them except fast variants. */
export function listedModels(p: ProviderView): ProviderModelView[] {
  return p.models.filter((m) => !isFastVariant(m, p.models))
}

/** The fast variant the chat's fast switch runs for a provider model, when the provider has one. */
export function providerFastVariant(p: ProviderView | undefined, model: string | undefined): ProviderModelView | undefined {
  if (!p || !model) return undefined
  return p.models.find((m) => !m.unavailable && (m.fastOf ? m.fastOf === model : m.value === fastModelId(model)))
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
    for (const m of listedModels(p)) {
      // The closed control shows the name on its own; inside the list the id follows in brackets, and
      // that id already says "[1m]", so the window marker is not repeated.
      const name = modelLabel(m.value).replace(/ \(1M\)$/, '')
      // A parenthetical in the launcher's own label says something the id does not ("what cc-ds uses
      // by itself"), so it is kept as a note rather than lost with the rest of the launcher's wording.
      const note = m.label.includes('(') ? m.label.slice(m.label.indexOf('(')).trim() : ''
      const fast = providerFastVariant(p, m.value)
      const fastNote = fast ? `Has fast mode${fast.description ? ` (${fast.description})` : ''}: the fast switch next to effort.` : ''
      const hint = [note, m.unavailable ?? m.description, fastNote].filter(Boolean).join('\n') || undefined
      out.push({ value: encodeModelChoice(p.id, m.value), label: `${name} (${m.value})`, short: name, hint, disabled: Boolean(m.unavailable) })
    }
    if (p.reason) out.push({ value: `note:${p.id}`, label: p.reason, disabled: true })
  }
  return out
}
