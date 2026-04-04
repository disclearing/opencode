import path from "path"
import { LANGUAGE_EXTENSIONS } from "../../../lsp/language"
import type { RunDiffStyle } from "./types"

export type ToolView = {
  output: boolean
  final: boolean
  snap?: "code" | "diff" | "structured"
}

export function toolView(name?: string): ToolView {
  switch (name) {
    case "bash":
      return {
        output: true,
        final: false,
      }
    case "write":
      return {
        output: false,
        final: true,
        snap: "code",
      }
    case "edit":
    case "apply_patch":
      return {
        output: false,
        final: true,
        snap: "diff",
      }
    case "task":
    case "todowrite":
    case "question":
      return {
        output: false,
        final: true,
        snap: "structured",
      }
    case "read":
    case "glob":
    case "grep":
    case "list":
    case "webfetch":
    case "codesearch":
    case "websearch":
    case "skill":
      return {
        output: false,
        final: false,
      }
    default:
      return {
        output: true,
        final: true,
      }
  }
}

export function toolFiletype(input?: string): string | undefined {
  if (!input) {
    return
  }

  const ext = path.extname(input)
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(lang)) {
    return "typescript"
  }

  return lang
}

export function toolDiffView(width: number, style: RunDiffStyle | undefined): "unified" | "split" {
  if (style === "stacked") {
    return "unified"
  }

  return width > 120 ? "split" : "unified"
}
