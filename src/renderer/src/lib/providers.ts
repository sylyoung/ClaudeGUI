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

/** Name of a model for the closed control: the provider's own label when known, else the id made readable. */
export function providerModelLabel(providers: ProviderView[], provider: string | undefined, model: string | undefined): string {
  if (!model) return modelLabel(model)
  const p = provider ? providers.find((x) => x.id === provider) : undefined
  const m = p?.models.find((x) => x.value === model)
  return m ? m.label : modelLabel(model)
}

/** Picker options for every other provider: a heading per provider, then its models (or why it is unavailable). */
export function providerModelOptions(providers: ProviderView[]): PopupOption[] {
  const out: PopupOption[] = []
  for (const p of providers) {
    out.push({ value: `heading:${p.id}`, label: p.name, heading: true, hint: `Runs "${p.launcher}" from your shell` })
    if (!p.available) {
      out.push({ value: `unavailable:${p.id}`, label: `Not available: ${p.reason ?? 'unknown reason'}`, disabled: true })
      continue
    }
    for (const m of p.models) {
      out.push({ value: encodeModelChoice(p.id, m.value), label: `${m.label} (${m.value})`, short: m.label, hint: m.unavailable ?? m.description, disabled: Boolean(m.unavailable) })
    }
    if (p.reason) out.push({ value: `note:${p.id}`, label: p.reason, disabled: true })
  }
  return out
}
