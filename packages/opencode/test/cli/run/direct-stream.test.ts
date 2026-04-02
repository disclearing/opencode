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

function idle() {
  return {
    type: "session.status",
    properties: {
      sessionID: "session-1",
      status: {
        type: "idle",
      },
    },
  }
}

function client(
  events: unknown[],
  opt: {
    prompt?: (payload: unknown, options: unknown) => Promise<void>
    reply?: (payload: unknown) => Promise<void>
  } = {},
) {
  return {
    event: {
      subscribe: async () => eventStream(events),
    },
    session: {
      prompt: opt.prompt ?? (async () => {}),
    },
    permission: {
      reply: opt.reply ?? (async () => {}),
    },
  } as unknown as OpencodeClient
}

type TurnOpt = Partial<Omit<Parameters<typeof runPromptTurn>[0], "sdk" | "sessionID" | "footer">>

async function turn(sdk: OpencodeClient, opt: TurnOpt = {}) {
  const patched: unknown[] = []
  const appended: unknown[] = []

  await runPromptTurn({
    sdk,
    sessionID: "session-1",
    agent: opt.agent,
    model: opt.model,
    variant: opt.variant,
    prompt: opt.prompt ?? "hello",
    files: opt.files ?? [],
    includeFiles: opt.includeFiles ?? false,
    thinking: opt.thinking ?? false,
    limits: opt.limits ?? {},
    signal: opt.signal,
    footer: {
      isClosed: false,
      onPrompt: () => () => {},
      onClose: () => () => {},
      patch(next) {
        patched.push(next)
      },
      append(commit) {
        appended.push(commit)
      },
      idle() {
        return Promise.resolve()
      },
      close() {},
      destroy() {},
    },
  })

  return {
    patched,
    appended,
  }
}

async function ask(events: unknown[]) {
  return turn(client([...events, idle()]), { prompt: "HELLO" })
}

describe("run stream", () => {
  test("keeps event order and ignores other sessions", async () => {
    const promptCalls: Array<{ payload: unknown; options: unknown }> = []

    const out = await turn(
      client(
        [
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
          idle(),
        ],
        {
          prompt: async (payload: unknown, options: unknown) => {
            promptCalls.push({ payload, options })
          },
        },
      ),
      {
        agent: "agent",
        files: [
          {
            type: "file",
            url: "file:///tmp/a.txt",
            filename: "a.txt",
            mime: "text/plain",
          },
        ],
        includeFiles: true,
        limits: {
          "openai/main-model": 1000,
        },
      },
    )

    expect(promptCalls).toHaveLength(1)
    expect((promptCalls[0]?.payload as { parts: unknown[] }).parts).toHaveLength(2)
    expect((promptCalls[0]?.payload as { parts: Array<{ type: string }> }).parts[0]?.type).toBe("file")
    expect((promptCalls[0]?.options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal)

    expect(out.patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(out.patched).toContainEqual({
      phase: "running",
      status: "running investigate",
    })
    expect(out.patched).toContainEqual({
      usage: "125 (13%) · $2.31",
    })
    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nassistant reply",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
      expect.objectContaining({
        kind: "tool",
        text: "[tool:task] running investigate",
        phase: "start",
        source: "tool",
        partID: "task-1",
        tool: "task",
      }),
      expect.objectContaining({
        kind: "tool",
        text: "[tool:bash] running bash",
        phase: "start",
        source: "tool",
        partID: "tool-1",
        tool: "bash",
      }),
      expect.objectContaining({
        kind: "tool",
        text: "file-a\n",
        phase: "progress",
        source: "tool",
        partID: "tool-1",
        tool: "bash",
      }),
      expect.objectContaining({
        kind: "tool",
        text: "[tool:bash:end]",
        phase: "final",
        source: "tool",
        partID: "tool-1",
        tool: "bash",
      }),
    ])
  })

  test("auto rejects permissions and emits session errors", async () => {
    const permissionReplies: unknown[] = []

    const out = await turn(
      client(
        [
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
          idle(),
        ],
        {
          reply: async (payload: unknown) => {
            permissionReplies.push(payload)
          },
        },
      ),
    )

    expect(permissionReplies).toEqual([
      {
        requestID: "perm-1",
        reply: "reject",
      },
    ])

    expect(out.patched).toContainEqual({
      phase: "running",
      status: "permission requested: read (/tmp/file.txt); auto-rejecting",
    })

    expect(out.appended).toEqual([
      {
        kind: "error",
        text: "permission denied",
        phase: "start",
        source: "system",
      },
    ])
  })

  test("keeps status-only events out of transcript commits", async () => {
    const replies: unknown[] = []

    const out = await turn(
      client(
        [
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
          idle(),
        ],
        {
          reply: async (payload: unknown) => {
            replies.push(payload)
          },
        },
      ),
    )

    expect(replies).toEqual([
      {
        requestID: "perm-1",
        reply: "reject",
      },
    ])

    expect(out.patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(out.patched).toContainEqual({
      phase: "running",
      status: "permission requested: read (/tmp/file.txt); auto-rejecting",
    })
    expect(out.patched).toContainEqual({
      phase: "running",
      status: "running investigate",
    })
    expect(out.appended).toEqual([
      expect.objectContaining({
        kind: "tool",
        partID: "tool-1",
        phase: "start",
        source: "tool",
        text: "[tool:task] running investigate",
        tool: "task",
      }),
      expect.objectContaining({
        kind: "tool",
        partID: "tool-1",
        phase: "progress",
        source: "tool",
        text: "ok",
        tool: "task",
      }),
      expect.objectContaining({
        kind: "tool",
        partID: "tool-1",
        phase: "final",
        source: "tool",
        text: "[tool:task:end]",
        tool: "task",
      }),
    ])
  })

  test("shows waiting status when assistant never announces", async () => {
    const out = await turn(client([idle()]))

    expect(out.patched).toContainEqual({
      phase: "running",
      status: "waiting for assistant",
    })
    expect(out.appended).toEqual([])
  })

  test("does not append assistant metadata rows to scrollback", async () => {
    const out = await turn(
      client([
        {
          type: "message.updated",
          properties: {
            sessionID: "session-1",
            info: {
              id: "msg-1",
              role: "assistant",
              agent: "main-agent",
              modelID: "minimax-m2.5-free",
              providerID: "minimax",
              tokens: {
                input: 10_000,
                output: 5_000,
                reasoning: 300,
                cache: { read: 0, write: 0 },
              },
              cost: 0,
              time: {
                created: 1000,
                completed: 2900,
              },
            },
          },
        },
        idle(),
      ]),
      {
        limits: {
          "minimax/minimax-m2.5-free": 200_000,
        },
      },
    )

    expect(out.patched).toContainEqual({
      phase: "running",
      status: "assistant responding",
    })
    expect(out.appended).toEqual([])
  })

  test("ignores echoed user text parts", async () => {
    const out = await ask([
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg-user-1",
            role: "user",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-user-1",
            messageID: "msg-user-1",
            sessionID: "session-1",
            type: "text",
            text: "HELLO",
            time: { end: Date.now() },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg-assistant-1",
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
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-assistant-1",
            messageID: "msg-assistant-1",
            sessionID: "session-1",
            type: "text",
            text: "Hello! How can I help you today?",
            time: { end: Date.now() },
          },
        },
      },
    ])

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nHello! How can I help you today?",
        phase: "progress",
        source: "assistant",
        partID: "txt-assistant-1",
      },
    ])
  })

  test("ignores user text part when role arrives later", async () => {
    const out = await ask([
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg-assistant-1",
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
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-user-1",
            messageID: "msg-user-1",
            sessionID: "session-1",
            type: "text",
            text: "HELLO",
            time: { end: Date.now() },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg-user-1",
            role: "user",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-assistant-1",
            messageID: "msg-assistant-1",
            sessionID: "session-1",
            type: "text",
            text: "Hello! How can I help you today?",
            time: { end: Date.now() },
          },
        },
      },
    ])

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nHello! How can I help you today?",
        phase: "progress",
        source: "assistant",
        partID: "txt-assistant-1",
      },
    ])
  })

  test("streams assistant text part when role arrives later", async () => {
    const out = await ask([
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-assistant-1",
            messageID: "msg-assistant-1",
            sessionID: "session-1",
            type: "text",
            text: "Hello after role",
            time: { end: Date.now() },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg-assistant-1",
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
    ])

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nHello after role",
        phase: "progress",
        source: "assistant",
        partID: "txt-assistant-1",
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

    await turn(sdk, { signal: ctrl.signal })

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
    const task = turn(sdk, { signal: ctrl.signal })

    ctrl.abort()
    await task

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
    const task = turn(sdk, { signal: ctrl.signal })

    ctrl.abort()

    const result = await Promise.race([
      task.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])

    expect(result).toBe("done")
  })

  test("streams assistant text in chunk order", async () => {
    const out = await turn(
      client([
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
        idle(),
      ]),
      { prompt: "hi" },
    )

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nhel",
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
    ])
  })

  test("buffers unknown part kind until part.updated arrives", async () => {
    const out = await turn(
      client([
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
        idle(),
      ]),
      { prompt: "hi" },
    )

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nhello",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
    ])
  })

  test("drops leading blank lines from first assistant chunk", async () => {
    const out = await turn(
      client([
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "txt-1",
              sessionID: "session-1",
              type: "text",
              text: "\n\nhello",
              time: { end: Date.now() },
            },
          },
        },
        idle(),
      ]),
      { prompt: "hi" },
    )

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nhello",
        phase: "progress",
        source: "assistant",
        partID: "txt-1",
      },
    ])
  })

  test("streams reasoning only when thinking=true", async () => {
    const out = await turn(
      client([
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
        idle(),
      ]),
      {
        prompt: "hi",
        thinking: false,
      },
    )

    expect(out.appended).toEqual([])
  })

  test("emits interrupted marker on abort", async () => {
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

    const out = await turn(sdk, {
      prompt: "hi",
      signal: ctrl.signal,
    })

    expect(out.appended).toEqual([
      {
        kind: "assistant",
        text: "\nunfinished",
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
