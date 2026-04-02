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
    const appended: Array<unknown> = []
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
        append(commit) {
          appended.push(commit)
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
      phase: "running",
      status: "running investigate",
    })
    expect(patched).toContainEqual({
      usage: "125 (13%) · $2.31",
    })
    expect(appended).toEqual([
      {
        kind: "assistant",
        text: "[assistant]",
        phase: "start",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "assistant reply",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "[assistant:end]",
        phase: "final",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "tool",
        text: "[tool:task] running investigate",
        phase: "start",
        source: "tool",
        partID: "task-1",
        tool: "task",
      },
      {
        kind: "tool",
        text: "file-a\n",
        phase: "progress",
        source: "tool",
        partID: "tool-1",
        tool: "bash",
      },
      {
        kind: "tool",
        text: "[tool:bash:end]",
        phase: "final",
        source: "tool",
        partID: "tool-1",
        tool: "bash",
      },
    ])
  })

  test("auto rejects permissions and emits session errors", async () => {
    const appended: Array<unknown> = []
    const patched: unknown[] = []
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
        patch(next) {
          patched.push(next)
        },
        append(commit) {
          appended.push(commit)
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

    expect(patched).toContainEqual({
      phase: "running",
      status: "permission requested: read (/tmp/file.txt); auto-rejecting",
    })

    expect(appended).toEqual([
      {
        kind: "error",
        text: "permission denied",
        phase: "start",
        source: "system",
      },
    ])
  })

  test("keeps status-only events out of transcript commits", async () => {
    const appended: Array<unknown> = []
    const patched: unknown[] = []
    const replies: unknown[] = []

    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.updated",
              properties: {
                sessionID: "session-1",
                info: {
                  role: "assistant",
                  agent: "main-agent",
                  modelID: "main-model",
                  providerID: "openai",
                  tokens: {
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
              },
            },
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
              type: "message.part.updated",
              properties: {
                part: {
                  id: "tool-1",
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
                  tool: "task",
                  state: {
                    status: "completed",
                    input: {},
                    output: "ok",
                    title: "done",
                    metadata: {},
                    time: { start: 1, end: 2 },
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
          replies.push(payload)
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
        patch(next) {
          patched.push(next)
        },
        append(commit) {
          appended.push(commit)
        },
        close() {},
        destroy() {},
      },
    })

    expect(replies).toEqual([
      {
        requestID: "perm-1",
        reply: "reject",
      },
    ])

    expect(patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(patched).toContainEqual({
      phase: "running",
      status: "permission requested: read (/tmp/file.txt); auto-rejecting",
    })
    expect(patched).toContainEqual({
      phase: "running",
      status: "running investigate",
    })
    expect(appended).toEqual([
      {
        kind: "tool",
        partID: "tool-1",
        phase: "start",
        source: "tool",
        text: "[tool:task] running investigate",
        tool: "task",
      },
      {
        kind: "tool",
        partID: "tool-1",
        phase: "progress",
        source: "tool",
        text: "ok",
        tool: "task",
      },
      {
        kind: "tool",
        partID: "tool-1",
        phase: "final",
        source: "tool",
        text: "[tool:task:end]",
        tool: "task",
      },
    ])
  })

  test("shows waiting status when assistant never announces", async () => {
    const patched: unknown[] = []
    const appended: Array<unknown> = []

    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
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
        reply: async () => {},
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
        patch(next) {
          patched.push(next)
        },
        append(commit) {
          appended.push(commit)
        },
        close() {},
        destroy() {},
      },
    })

    expect(patched).toContainEqual({
      phase: "running",
      status: "waiting for assistant",
    })
    expect(appended).toEqual([])
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

  test("canceled turn does not wait for stuck event stream", async () => {
    const sdk = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            await new Promise<void>(() => {})
          })(),
        }),
      },
      session: {
        prompt: async (_: unknown, options?: { signal?: AbortSignal }) => {
          await new Promise<void>((resolve, reject) => {
            if (options?.signal?.aborted) {
              reject(new Error("aborted"))
              return
            }

            options?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"))
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

    const result = await Promise.race([
      run.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])

    expect(result).toBe("done")
  })

  test("streams assistant text in chunk order", async () => {
    const appended: Array<unknown> = []
    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "",
                },
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: "session-1",
                partID: "txt-1",
                field: "text",
                delta: "hel",
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: "session-1",
                partID: "txt-1",
                field: "text",
                delta: "lo",
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "hello",
                  time: { end: Date.now() },
                },
              },
            },
            {
              type: "session.status",
              properties: { sessionID: "session-1", status: { type: "idle" } },
            },
          ]),
      },
      session: { prompt: async () => {} },
      permission: { reply: async () => {} },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hi",
      files: [],
      includeFiles: false,
      thinking: false,
      limits: {},
      footer: {
        isClosed: false,
        onPrompt: () => () => {},
        onClose: () => () => {},
        patch: () => {},
        append: (commit) => appended.push(commit),
        close: () => {},
        destroy: () => {},
      },
    })

    expect(appended).toEqual([
      {
        kind: "assistant",
        text: "[assistant]",
        phase: "start",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "hel",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "lo",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "[assistant:end]",
        phase: "final",
        source: "assistant",
        partID: "txt-1",
      },
    ])
  })

  test("buffers unknown part kind until part.updated arrives", async () => {
    const appended: Array<unknown> = []
    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.part.delta",
              properties: {
                sessionID: "session-1",
                partID: "txt-1",
                field: "text",
                delta: "hello",
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "hello",
                  time: { end: Date.now() },
                },
              },
            },
            {
              type: "session.status",
              properties: { sessionID: "session-1", status: { type: "idle" } },
            },
          ]),
      },
      session: { prompt: async () => {} },
      permission: { reply: async () => {} },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hi",
      files: [],
      includeFiles: false,
      thinking: false,
      limits: {},
      footer: {
        isClosed: false,
        onPrompt: () => () => {},
        onClose: () => () => {},
        patch: () => {},
        append: (commit) => appended.push(commit),
        close: () => {},
        destroy: () => {},
      },
    })

    expect(appended).toEqual([
      {
        kind: "assistant",
        text: "[assistant]",
        phase: "start",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "hello",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "[assistant:end]",
        phase: "final",
        source: "assistant",
        partID: "txt-1",
      },
    ])
  })

  test("streams reasoning only when thinking=true", async () => {
    const appended: Array<unknown> = []
    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "reason-1",
                  sessionID: "session-1",
                  type: "reasoning",
                  text: "think",
                  time: { end: Date.now() },
                },
              },
            },
            {
              type: "session.status",
              properties: { sessionID: "session-1", status: { type: "idle" } },
            },
          ]),
      },
      session: { prompt: async () => {} },
      permission: { reply: async () => {} },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hi",
      files: [],
      includeFiles: false,
      thinking: false,
      limits: {},
      footer: {
        isClosed: false,
        onPrompt: () => () => {},
        onClose: () => () => {},
        patch: () => {},
        append: (commit) => appended.push(commit),
        close: () => {},
        destroy: () => {},
      },
    })

    expect(appended).toEqual([])
  })

  test("emits interrupted marker on abort", async () => {
    const appended: Array<unknown> = []
    const ctrl = new AbortController()

    const sdk = {
      event: {
        subscribe: async () =>
          eventStream([
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "txt-1",
                  sessionID: "session-1",
                  type: "text",
                  text: "",
                },
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: "session-1",
                partID: "txt-1",
                field: "text",
                delta: "unfinished",
              },
            },
            {
              type: "session.status",
              properties: { sessionID: "session-1", status: { type: "idle" } },
            },
          ]),
      },
      session: {
        prompt: async () => {
          await new Promise((r) => setTimeout(r, 10))
          ctrl.abort()
        },
      },
      permission: { reply: async () => {} },
    } as unknown as OpencodeClient

    await runPromptTurn({
      sdk,
      sessionID: "session-1",
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: "hi",
      files: [],
      includeFiles: false,
      thinking: false,
      limits: {},
      signal: ctrl.signal,
      footer: {
        isClosed: false,
        onPrompt: () => () => {},
        onClose: () => () => {},
        patch: () => {},
        append: (commit) => appended.push(commit),
        close: () => {},
        destroy: () => {},
      },
    })

    expect(appended).toEqual([
      {
        kind: "assistant",
        text: "[assistant]",
        phase: "start",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "unfinished",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "[assistant:interrupted]",
        phase: "final",
        source: "assistant",
        partID: "txt-1",
      },
    ])
  })
})
