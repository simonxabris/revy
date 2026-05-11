import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core"

type TextMateFontStyle = string | number

interface TextMateTokenSettings {
  readonly foreground?: string
  readonly background?: string
  readonly fontStyle?: TextMateFontStyle
}

interface TextMateTokenStyle {
  readonly scope?: string | readonly string[]
  readonly settings?: TextMateTokenSettings
}

export interface TextMateTheme {
  readonly fg?: string
  readonly bg?: string
  readonly colors?: Record<string, string | null>
  readonly settings?: readonly TextMateTokenStyle[]
  readonly tokenColors?: readonly TextMateTokenStyle[]
}

export interface OpenTuiDiffTheme {
  syntaxStyle: SyntaxStyle
  backgroundColor: string
  fg: string
  addedBg: string
  removedBg: string
  contextBg: string
  addedSignColor: string
  removedSignColor: string
  lineNumberFg: string
  lineNumberBg: string
  addedLineNumberBg: string
  removedLineNumberBg: string
  selectionBg: string
  selectionFg: string
  activeLineBg: string
  activeLineNumberBg: string
}

const textMateScopeMap: Array<[string, string[]]> = [
  ["comment", ["comment"]],
  ["constant.language.boolean", ["boolean", "constant"]],
  ["constant.numeric", ["number", "constant"]],
  ["constant", ["constant"]],
  ["entity.name.function", ["function", "function.call"]],
  ["entity.name.type", ["type", "constructor"]],
  ["entity.name.class", ["type", "constructor"]],
  ["entity.other.attribute-name", ["property"]],
  ["keyword.operator", ["operator"]],
  ["keyword", ["keyword", "keyword.import"]],
  ["meta.import", ["keyword.import"]],
  ["punctuation.definition.string", ["string"]],
  ["punctuation", ["punctuation", "bracket"]],
  ["storage.type", ["type", "keyword"]],
  ["storage", ["keyword"]],
  ["string", ["string"]],
  ["support.function", ["function", "function.call"]],
  ["support.type", ["type"]],
  ["support.class", ["type", "constructor"]],
  ["variable.other.property", ["property"]],
  ["variable.parameter", ["variable"]],
  ["variable", ["variable"]],
]

function textMateThemeToOpenTuiStyles(theme: TextMateTheme): Record<string, StyleDefinitionInput> {
  const styles: Record<string, StyleDefinitionInput> = {}
  const tokenStyles = theme.settings ?? theme.tokenColors ?? []

  if (theme.fg) {
    styles.default = { fg: theme.fg }
  }

  for (const tokenStyle of tokenStyles) {
    if (!tokenStyle.settings) continue

    const style = toOpenTuiStyle(tokenStyle.settings)
    if (!style) continue

    if (!tokenStyle.scope) {
      styles.default = { ...styles.default, ...style }
      continue
    }

    for (const scope of toScopes(tokenStyle.scope)) {
      for (const name of openTuiNamesForTextMateScope(scope)) {
        styles[name] = { ...styles[name], ...style }
      }
    }
  }

  return styles
}

export function textMateThemeToSyntaxStyle(theme: TextMateTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles(textMateThemeToOpenTuiStyles(theme))
}

export function textMateThemeToDiffTheme(theme: TextMateTheme): OpenTuiDiffTheme {
  const colors = theme.colors ?? {}
  const backgroundColor = blendColor(colors["editor.background"] ?? theme.bg ?? "#0d1117", "#ffffff")
  const fg = blendColor(colors["editor.foreground"] ?? colors.foreground ?? theme.fg ?? "#e6edf3", backgroundColor)
  const addedSignColor = blendColor(colors["editorGutter.addedBackground"] ?? "#3fb950", backgroundColor)
  const removedSignColor = blendColor(colors["editorGutter.deletedBackground"] ?? "#f85149", backgroundColor)

  return {
    syntaxStyle: textMateThemeToSyntaxStyle(theme),
    backgroundColor,
    fg,
    addedBg: blendColor(colors["diffEditor.insertedTextBackground"] ?? "#1f3d2b", backgroundColor),
    removedBg: blendColor(colors["diffEditor.removedTextBackground"] ?? "#4a2428", backgroundColor),
    contextBg: backgroundColor,
    addedSignColor,
    removedSignColor,
    lineNumberFg: blendColor(colors["editorLineNumber.foreground"] ?? "#6e7681", backgroundColor),
    lineNumberBg: backgroundColor,
    addedLineNumberBg: blendColor(withAlphaFallback(addedSignColor, "33"), backgroundColor),
    removedLineNumberBg: blendColor(withAlphaFallback(removedSignColor, "33"), backgroundColor),
    selectionBg: blendColor(colors["editor.selectionBackground"] ?? "#264f78", backgroundColor),
    selectionFg: blendColor(colors["editor.selectionForeground"] ?? fg, backgroundColor),
    activeLineBg: blendColor(colors["editor.lineHighlightBackground"] ?? "#264f78", backgroundColor),
    activeLineNumberBg: blendColor(colors["editorLineNumber.activeForeground"] ?? colors["editor.lineHighlightBackground"] ?? "#264f78", backgroundColor),
  }
}

function toScopes(scope: string | readonly string[]): string[] {
  return typeof scope === "string" ? scope.split(",").map((item) => item.trim()).filter(Boolean) : [...scope]
}

function openTuiNamesForTextMateScope(scope: string): string[] {
  const names = new Set<string>()

  for (const [textMatePrefix, openTuiNames] of textMateScopeMap) {
    if (scope === textMatePrefix || scope.startsWith(`${textMatePrefix}.`)) {
      for (const name of openTuiNames) names.add(name)
    }
  }

  return [...names]
}

function toOpenTuiStyle(settings: TextMateTokenSettings): StyleDefinitionInput | null {
  const style: StyleDefinitionInput = {}

  if (settings.foreground) style.fg = settings.foreground

  const fontStyle = parseFontStyle(settings.fontStyle)
  if (fontStyle) Object.assign(style, fontStyle)

  return Object.keys(style).length ? style : null
}

function parseFontStyle(fontStyle: TextMateFontStyle | undefined): Pick<StyleDefinitionInput, "bold" | "italic" | "underline"> | null {
  if (fontStyle === undefined || fontStyle === "" || fontStyle === -1) return null

  if (typeof fontStyle === "number") {
    return {
      italic: Boolean(fontStyle & 1),
      bold: Boolean(fontStyle & 2),
      underline: Boolean(fontStyle & 4),
    }
  }

  const parts = new Set(fontStyle.split(/\s+/).filter(Boolean))
  return {
    italic: parts.has("italic"),
    bold: parts.has("bold"),
    underline: parts.has("underline"),
  }
}

function blendColor(color: string, background: string): string {
  const fg = parseHexColor(color)
  const bg = parseHexColor(background)
  if (!fg || !bg || fg.a === 255) return color.slice(0, 7)

  const alpha = fg.a / 255
  const r = Math.round(fg.r * alpha + bg.r * (1 - alpha))
  const g = Math.round(fg.g * alpha + bg.g * (1 - alpha))
  const b = Math.round(fg.b * alpha + bg.b * (1 - alpha))
  return rgbToHex(r, g, b)
}

function withAlphaFallback(color: string, alphaHex: string): string {
  return color.length === 7 ? `${color}${alphaHex}` : color
}

function parseHexColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color)
  if (!match) return null

  const hex = match[1]
  if (!hex) return null

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: match[2] ? Number.parseInt(match[2], 16) : 255,
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0")
}
