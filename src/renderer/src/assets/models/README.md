# Model company logos

The mark of the company a chat's model comes from, drawn before the model name in the sidebar row
and in the chat's model picker. The user asked for the model to be told apart by its logo instead of
by a colour, so these files are the identity of the row: the model name itself is written in the
normal text colour.

| File | Company | Source file | Colour |
| --- | --- | --- | --- |
| `claude.svg` | Anthropic (Claude, Fable, Opus, Sonnet, Haiku) | `claude-color.svg` | the mark's own coral |
| `gpt.svg` | OpenAI (GPT, Codex, Astra) | `openai.svg` | `currentColor` — the mark is monochrome |
| `deepseek.svg` | DeepSeek | `deepseek-color.svg` | the mark's own blue |
| `kimi.svg` | Moonshot AI (Kimi) | `kimi.svg` | `currentColor` — the colour version draws the K in white, which disappears on a light background |

Downloaded from the `@lobehub/icons-static-svg` package (https://github.com/lobehub/lobe-icons, MIT),
which publishes each provider's own mark as a 24×24 SVG sized in `em`. They are inlined by
`src/renderer/src/components/common/ModelIcon.tsx` rather than loaded as images, so the two
monochrome marks can take the colour of the text they sit next to. Each logo remains the trademark
of its company and is used here only to name the model a chat runs on.
