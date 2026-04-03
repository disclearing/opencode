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
