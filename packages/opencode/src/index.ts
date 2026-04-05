import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { Log } from "./util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "./util/filesystem"
import { EOL } from "os"
import path from "path"
import { Global } from "./global"
import { JsonMigration } from "./storage/json-migration"
import { Database } from "./storage/db"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function first(argv: string[]) {
  return argv.find((item) => item.length > 0 && !item.startsWith("-"))
}

const cmd = first(args)
const known = new Set([
  "run",
  "acp",
  "mcp",
  "debug",
  "console",
  "providers",
  "auth",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "session",
  "plugin",
  "plug",
  "db",
  "generate",
  "attach",
])
const all =
  cmd === undefined ||
  cmd === "completion" ||
  args.includes("-h") ||
  args.includes("--help") ||
  (cmd !== undefined && !known.has(cmd))

function load<T>(on: boolean, get: () => Promise<T>): Promise<T | undefined> {
  if (!on) {
    return Promise.resolve(undefined)
  }

  return get()
}

const [
  AttachCommand,
  TuiThreadCommand,
  AcpCommand,
  McpCommand,
  GenerateCommand,
  DebugCommand,
  ConsoleCommand,
  ProvidersCommand,
  AgentCommand,
  UpgradeCommand,
  UninstallCommand,
  ServeCommand,
  WebCommand,
  ModelsCommand,
  StatsCommand,
  ExportCommand,
  ImportCommand,
  GithubCommand,
  PrCommand,
  SessionCommand,
  PluginCommand,
  DbCommand,
] = await Promise.all([
  load(all || cmd === "attach", () => import("./cli/cmd/tui/attach").then((x) => x.AttachCommand)),
  load(all || cmd === undefined, () => import("./cli/cmd/tui/thread").then((x) => x.TuiThreadCommand)),
  load(all || cmd === "acp", () => import("./cli/cmd/acp").then((x) => x.AcpCommand)),
  load(all || cmd === "mcp", () => import("./cli/cmd/mcp").then((x) => x.McpCommand)),
  load(all || cmd === "generate", () => import("./cli/cmd/generate").then((x) => x.GenerateCommand)),
  load(all || cmd === "debug", () => import("./cli/cmd/debug").then((x) => x.DebugCommand)),
  load(all || cmd === "console", () => import("./cli/cmd/account").then((x) => x.ConsoleCommand)),
  load(all || cmd === "providers" || cmd === "auth", () =>
    import("./cli/cmd/providers").then((x) => x.ProvidersCommand),
  ),
  load(all || cmd === "agent", () => import("./cli/cmd/agent").then((x) => x.AgentCommand)),
  load(all || cmd === "upgrade", () => import("./cli/cmd/upgrade").then((x) => x.UpgradeCommand)),
  load(all || cmd === "uninstall", () => import("./cli/cmd/uninstall").then((x) => x.UninstallCommand)),
  load(all || cmd === "serve", () => import("./cli/cmd/serve").then((x) => x.ServeCommand)),
  load(all || cmd === "web", () => import("./cli/cmd/web").then((x) => x.WebCommand)),
  load(all || cmd === "models", () => import("./cli/cmd/models").then((x) => x.ModelsCommand)),
  load(all || cmd === "stats", () => import("./cli/cmd/stats").then((x) => x.StatsCommand)),
  load(all || cmd === "export", () => import("./cli/cmd/export").then((x) => x.ExportCommand)),
  load(all || cmd === "import", () => import("./cli/cmd/import").then((x) => x.ImportCommand)),
  load(all || cmd === "github", () => import("./cli/cmd/github").then((x) => x.GithubCommand)),
  load(all || cmd === "pr", () => import("./cli/cmd/pr").then((x) => x.PrCommand)),
  load(all || cmd === "session", () => import("./cli/cmd/session").then((x) => x.SessionCommand)),
  load(all || cmd === "plugin" || cmd === "plug", () => import("./cli/cmd/plug").then((x) => x.PluginCommand)),
  load(all || cmd === "db", () => import("./cli/cmd/db").then((x) => x.DbCommand)),
])

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })

    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(Database.Client().$client, {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")

if (TuiThreadCommand) {
  cli.command(TuiThreadCommand)
}

if (AttachCommand) {
  cli.command(AttachCommand)
}

if (AcpCommand) {
  cli.command(AcpCommand)
}

if (McpCommand) {
  cli.command(McpCommand)
}

cli.command(RunCommand)

if (GenerateCommand) {
  cli.command(GenerateCommand)
}

if (DebugCommand) {
  cli.command(DebugCommand)
}

if (ConsoleCommand) {
  cli.command(ConsoleCommand)
}

if (ProvidersCommand) {
  cli.command(ProvidersCommand)
}

if (AgentCommand) {
  cli.command(AgentCommand)
}

if (UpgradeCommand) {
  cli.command(UpgradeCommand)
}

if (UninstallCommand) {
  cli.command(UninstallCommand)
}

if (ServeCommand) {
  cli.command(ServeCommand)
}

if (WebCommand) {
  cli.command(WebCommand)
}

if (ModelsCommand) {
  cli.command(ModelsCommand)
}

if (StatsCommand) {
  cli.command(StatsCommand)
}

if (ExportCommand) {
  cli.command(ExportCommand)
}

if (ImportCommand) {
  cli.command(ImportCommand)
}

if (GithubCommand) {
  cli.command(GithubCommand)
}

if (PrCommand) {
  cli.command(PrCommand)
}

if (SessionCommand) {
  cli.command(SessionCommand)
}

if (PluginCommand) {
  cli.command(PluginCommand)
}

if (DbCommand) {
  cli.command(DbCommand)
}

cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
