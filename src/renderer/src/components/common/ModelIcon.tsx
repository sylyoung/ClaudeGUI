import claudeIcon from '@/assets/models/claude.svg?raw'
import deepseekIcon from '@/assets/models/deepseek.svg?raw'
import gptIcon from '@/assets/models/gpt.svg?raw'
import kimiIcon from '@/assets/models/kimi.svg?raw'
import { modelCompany } from '@/lib/format'

/** The logo of the company each model comes from (see src/renderer/src/assets/models/README.md). */
const ICONS: Record<string, string> = {
  claude: claudeIcon,
  gpt: gptIcon,
  deepseek: deepseekIcon,
  kimi: kimiIcon
}

/**
 * Each downloaded file names itself in a <title> element, which the browser would show as its own
 * tooltip over the logo and would copy along with the row's text, so it is dropped when the file is
 * inlined; the row keeps its own explanation of the model.
 */
const noTitle = (svg: string) => svg.replace(/<title>[\s\S]*?<\/title>/g, '')

/**
 * The mark of the company a model comes from, drawn immediately before the model's name. This is
 * what tells one provider from another at a glance: the user asked for the logo instead of a colour,
 * so the name beside it is written in the normal text colour like the rest of the row.
 *
 * The file is inlined rather than used as an image source, because the OpenAI and Kimi marks are
 * drawn in `currentColor` and have to take the colour of the text they stand next to; a model whose
 * company is unknown has no mark at all.
 */
export function ModelIcon({ model, size = 12 }: { model: string | undefined; size?: number }) {
  const svg = ICONS[modelCompany(model)]
  if (!svg) return null
  return <span className="model-icon" style={{ fontSize: size }} aria-hidden dangerouslySetInnerHTML={{ __html: noTitle(svg) }} />
}
