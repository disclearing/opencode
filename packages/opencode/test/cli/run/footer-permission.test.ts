import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { permissionInfo } from "../../../src/cli/cmd/run/footer.permission"

function req(input: Partial<PermissionRequest>): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run footer permission mapping", () => {
  test("maps supported permission types into titles and body content", () => {
    expect(
      permissionInfo(
        req({
          permission: "edit",
          patterns: ["src/file.ts"],
          metadata: { filepath: `${process.cwd()}/src/file.ts`, diff: "@@ -1 +1 @@\n-old\n+new\n" },
        }),
      ),
    ).toMatchObject({
      title: "Edit src/file.ts",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
    })

    expect(
      permissionInfo(
        req({
          permission: "read",
          patterns: ["src/file.ts"],
          metadata: {},
        }),
      ),
    ).toMatchObject({
      title: "Read src/file.ts",
      lines: ["Path: src/file.ts"],
    })

    expect(permissionInfo(req({ permission: "bash", metadata: {} }))).toMatchObject({
      title: "Shell command",
      lines: [],
    })

    expect(
      permissionInfo(req({ permission: "bash", metadata: { input: { command: "git status --short" } } })),
    ).toMatchObject({
      title: "Shell command",
      lines: ["$ git status --short"],
    })

    expect(
      permissionInfo(
        req({
          permission: "task",
          metadata: { description: "investigate stream", subagent_type: "general" },
        }),
      ),
    ).toMatchObject({
      title: "General Task",
      lines: ["◉ investigate stream"],
    })

    expect(
      permissionInfo(
        req({
          permission: "external_directory",
          patterns: ["/tmp/work/**/*.ts", "/tmp/work/**/*.tsx"],
        }),
      ),
    ).toMatchObject({
      title: "Access external directory /tmp/work",
      lines: ["- /tmp/work/**/*.ts", "- /tmp/work/**/*.tsx"],
    })

    expect(permissionInfo(req({ permission: "doom_loop" }))).toMatchObject({
      title: "Continue after repeated failures",
    })

    expect(permissionInfo(req({ permission: "something_else" }))).toMatchObject({
      title: "Call tool something_else",
      lines: ["Tool: something_else"],
    })
  })
})
