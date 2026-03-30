export const logo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export const marks = "_^~"

export type LogoCell = {
  char: string
  mark: "text" | "full" | "mix" | "top"
}

export function logoCells(line: string): LogoCell[] {
  const cells: LogoCell[] = []
  for (const char of line) {
    if (char === "_") {
      cells.push({
        char: " ",
        mark: "full",
      })
      continue
    }

    if (char === "^") {
      cells.push({
        char: "▀",
        mark: "mix",
      })
      continue
    }

    if (char === "~") {
      cells.push({
        char: "▀",
        mark: "top",
      })
      continue
    }

    cells.push({
      char,
      mark: "text",
    })
  }

  return cells
}
