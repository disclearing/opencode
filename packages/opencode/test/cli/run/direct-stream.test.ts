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
    const promptCalls: Array<{ payload: unknown; options: unknown }> = []

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
                  providerID: "openai",
                  cost: 2.31,
                  tokens: {
                    input: 42,
                    output: 58,
                    reasoning: 10,
                    cache: {
                      read: 15,
                      write: 0,
                    },
                  },
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
        prompt: async (payload: unknown, options: unknown) => {
          promptCalls.push({ payload, options })
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
      limits: {
        "openai/main-model": 1000,
      },
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
    expect((promptCalls[0]?.payload as { parts: unknown[] }).parts).toHaveLength(2)
    expect((promptCalls[0]?.payload as { parts: Array<{ type: string }> }).parts[0]?.type).toBe("file")
    expect((promptCalls[0]?.options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal)

    expect(patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(patched).toContainEqual({
      usage: "125 (13%) · $2.31",
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
      limits: {},
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

  test("returns immediately when close signal is already aborted", async () => {
    let subscribed = 0
    let prompted = 0

    const sdk = {
      event: {
        subscribe: async () => {
          subscribed += 1
          return eventStream([])
        },
      },
      session: {
        prompt: async () => {
          prompted += 1
        },
      },
      permission: {
        reply: async () => {},
      },
    } as unknown as OpencodeClient

    const ctrl = new AbortController()
    ctrl.abort()

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
      limits: {},
      signal: ctrl.signal,
      footer: {
        isClosed: false,
        onPrompt() {
          return () => {}
        },
        onClose() {
          return () => {}
        },
        patch() {},
        append() {},
        close() {},
        destroy() {},
      },
    })

    expect(subscribed).toBe(0)
    expect(prompted).toBe(0)
  })

  test("aborts in-flight prompt when close signal fires", async () => {
    let aborted = false

    const sdk = {
      event: {
        subscribe: async (_: unknown, options?: { signal?: AbortSignal }) => ({
          stream: (async function* () {
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve()
                return
              }

              options?.signal?.addEventListener("abort", () => resolve(), { once: true })
            })
          })(),
        }),
      },
      session: {
        prompt: async (_: unknown, options?: { signal?: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) {
              aborted = true
              resolve()
              return
            }

            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            )
          })
        },
      },
      permission: {
        reply: async () => {},
      },
    } as unknown as OpencodeClient

    const ctrl = new AbortController()
    const run = runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hello",
      files: [],
      includeFiles: false,
      thinking: false,
      limits: {},
      signal: ctrl.signal,
      footer: {
        isClosed: false,
        onPrompt() {
          return () => {}
        },
        onClose() {
          return () => {}
        },
        patch() {},
        append() {},
        close() {},
        destroy() {},
      },
    })

    ctrl.abort()
    await run

    expect(aborted).toBe(true)
  })
})
