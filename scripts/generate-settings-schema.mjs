import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
const declaration = path.join(sdkDir, 'sdk.d.ts')
const program = ts.createProgram([declaration], { strictNullChecks: true, skipLibCheck: true })
const checker = program.getTypeChecker()
const source = program.getSourceFile(declaration)
const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find((s) => s.name === 'Settings')
if (!symbol) throw new Error('The installed Claude Agent SDK does not declare Settings')

function schema(type, ancestors = new Set()) {
  if (ancestors.has(type) || ancestors.size > 24) return {}
  const seen = new Set([...ancestors, type])
  if (type.isUnion()) {
    const members = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
    if (members.length === 1) return schema(members[0], seen)
    const variants = members.map((t) => schema(t, seen))
    if (variants.every((v) => 'const' in v)) {
      const values = variants.map((v) => v.const)
      if (values.length === 2 && values.includes(true) && values.includes(false)) return { type: 'boolean' }
      return { enum: values }
    }
    return { anyOf: variants }
  }
  if (type.flags & ts.TypeFlags.StringLiteral) return { const: type.value }
  if (type.flags & ts.TypeFlags.NumberLiteral) return { const: type.value }
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true' }
  if (type.flags & ts.TypeFlags.String) return { type: 'string' }
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' }
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' }
  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type)
    const flags = type.target.elementFlags
    const rest = flags.findIndex((f) => f & ts.ElementFlags.Rest)
    const fixed = rest < 0 ? args.length : rest
    return {
      type: 'array', prefixItems: args.slice(0, fixed).map((t) => schema(t, seen)),
      minItems: flags.filter((f) => f & ts.ElementFlags.Required).length,
      ...(rest < 0 ? { maxItems: args.length } : { items: schema(args[rest], seen) })
    }
  }
  if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0], seen) }
  if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
    const properties = {}, required = []
    for (const prop of type.getProperties()) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0]
      if (!declaration) continue
      const description = ts.displayPartsToString(prop.getDocumentationComment(checker))
      properties[prop.name] = { ...schema(checker.getTypeOfSymbolAtLocation(prop, declaration), seen), ...(description && { description }) }
      if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.name)
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String)
    return { type: 'object', properties, ...(required.length && { required }), additionalProperties: index ? schema(index, seen) : false }
  }
  return {}
}

const settings = schema(checker.getDeclaredTypeOfSymbol(symbol))
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')).version
const output = JSON.stringify({ sdkVersion, ...settings }, null, 2) + '\n'
const target = path.join(root, 'src/shared/claudeSettingsSchema.json')
if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) fs.writeFileSync(target, output)
console.log(`Claude Code settings catalogue: ${Object.keys(settings.properties).length} settings (SDK ${sdkVersion})`)
