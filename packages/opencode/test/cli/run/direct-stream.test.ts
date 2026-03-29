import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { runPromptTurn } from "../../../src/cli/cmd/run/stream"

function eventStream(events: unknown[]) {
  return {
    stream: (async function* () {
      for (const event of events) {
        yield event
      }
    })(),
  }
}

describe("run stream", () => {
  test("keeps event order and ignores other sessions", async () => {
    const appended: Array<{ kind: string; text: string }> = []
    const patched: unknown[] = []
    const promptCalls: unknown[] = []

    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.updated",
              properties: {
                sessionID: "other",
                info: {
                  role: "assistant",
                  agent: "other-agent",
                  modelID: "other-model",
                },
              },
            },
            {
              type: "message.updated",
              properties: {
                sessionID: "session-1",
                info: {
                  role: "assistant",
                  agent: "main-agent",
                  modelID: "main-model",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "assistant reply",
                  time: { end: Date.now() },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "assistant reply",
                  time: { end: Date.now() },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "task-1",
                  sessionID: "session-1",
                  type: "tool",
                  tool: "task",
                  state: {
                    status: "running",
                    input: {
                      description: "investigate",
                    },
                  },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "tool-1",
                  sessionID: "session-1",
                  type: "tool",
                  tool: "bash",
                  state: {
                    status: "completed",
                    input: {
                      command: "ls",
                    },
                    output: "file-a\n",
                  },
                },
              },
            },
            {
              type: "session.status",
              properties: {
                sessionID: "session-1",
                status: {
                  type: "idle",
                },
              },
            },
          ]),
      },
      session: {
        prompt: async (payload: unknown) => {
          promptCalls.push(payload)
        },
      },
      permission: {
        reply: async () => {},
      },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: "agent",
      model: undefined,
      variant: undefined,
      prompt: "hello",
      files: [
        {
          type: "file",
          url: "file:///tmp/a.txt",
          filename: "a.txt",
          mime: "text/plain",
        },
      ],
      includeFiles: true,
      thinking: false,
      footer: {
        isClosed: false,
        onPrompt() {
          return () => {}
        },
        onClose() {
          return () => {}
        },
        patch(next) {
          patched.push(next)
        },
        append(kind, text) {
          appended.push({ kind, text })
        },
        close() {},
        destroy() {},
      },
    })

    expect(promptCalls).toHaveLength(1)
    expect((promptCalls[0] as { parts: unknown[] }).parts).toHaveLength(2)
    expect((promptCalls[0] as { parts: Array<{ type: string }> }).parts[0]?.type).toBe("file")

    expect(patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(appended).toEqual([
      { kind: "system", text: "main-agent · main-model" },
      { kind: "assistant", text: "assistant reply" },
      { kind: "tool", text: "running investigate" },
      { kind: "tool", text: "$ ls\nfile-a" },
    ])
  })

  test("auto rejects permissions and emits session errors", async () => {
    const appended: Array<{ kind: string; text: string }> = []
    const permissionReplies: unknown[] = []

    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "permission.asked",
              properties: {
                id: "perm-1",
                sessionID: "session-1",
                permission: "read",
                patterns: ["/tmp/file.txt"],
              },
            },
            {
              type: "session.error",
              properties: {
                sessionID: "session-1",
                error: {
                  name: "UnknownError",
                  data: {
                    message: "permission denied",
                  },
                },
              },
            },
            {
              type: "session.status",
              properties: {
                sessionID: "session-1",
                status: {
                  type: "idle",
                },
              },
            },
          ]),
      },
      session: {
        prompt: async () => {},
      },
      permission: {
        reply: async (payload: unknown) => {
          permissionReplies.push(payload)
        },
      },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hello",
      files: [],
      includeFiles: false,
      thinking: false,
      footer: {
        isClosed: false,
        onPrompt() {
          return () => {}
        },
        onClose() {
          return () => {}
        },
        patch() {},
        append(kind, text) {
          appended.push({ kind, text })
        },
        close() {},
        destroy() {},
      },
    })

    expect(permissionReplies).toEqual([
      {
        requestID: "perm-1",
        reply: "reject",
      },
    ])

    expect(appended).toEqual([
      {
        kind: "system",
        text: "permission requested: read (/tmp/file.txt); auto-rejecting",
      },
      {
        kind: "error",
        text: "permission denied",
      },
    ])
  })
})
