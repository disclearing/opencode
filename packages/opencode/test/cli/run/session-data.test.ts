import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { createSessionData, reduceSessionData } from "../../../src/cli/cmd/run/session-data"

function reduce(data: ReturnType<typeof createSessionData>, event: unknown, thinking = false) {
  return reduceSessionData({
    data,
    event: event as Event,
    sessionID: "session-1",
    thinking,
    limits: {},
  })
}

function assistant(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
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
        ...extra,
      },
    },
  }
}

describe("session data reducer", () => {
  test("buffers delta until part kind is known", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "hello",
      },
    }).data

    data = reduce(data, assistant("msg-1")).data

    const out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "",
          time: { end: Date.now() },
        },
      },
    })

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: "hello",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])
  })

  test("replays buffered assistant part once role is known", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "hello after role",
          time: { end: Date.now() },
        },
      },
    }).data

    const out = reduce(data, assistant("msg-1"))

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: "hello after role",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])
    expect(out.footer).toEqual({
      patch: { status: "assistant responding", usage: "2" },
      view: undefined,
    })
  })

  test("drops synced user parts when role arrives later", () => {
    let data = createSessionData()

    data = reduce(data, {
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
    }).data

    const out = reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "msg-user-1",
          role: "user",
        },
      },
    })

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("txt-user-1")).toBe(true)
  })

  test("suppresses reasoning when thinking is disabled", () => {
    const out = reduce(
      createSessionData(),
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reason-1",
            messageID: "msg-1",
            sessionID: "session-1",
            type: "reasoning",
            text: "hidden",
            time: { end: Date.now() },
          },
        },
      },
      false,
    )

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("reason-1")).toBe(true)
  })

  test("emits tool lifecycle in stable order", () => {
    let data = createSessionData()

    const run = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
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
    })

    expect(run.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        text: "[tool:task] running investigate",
        phase: "start",
        source: "tool",
        messageID: "msg-1",
        partID: "tool-1",
        tool: "task",
      }),
    ])
    expect(run.footer).toEqual({
      patch: { status: "running investigate" },
      view: undefined,
    })

    data = run.data
    const done = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
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
    })

    expect(done.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        text: "ok",
        phase: "progress",
        source: "tool",
        messageID: "msg-1",
        partID: "tool-1",
        tool: "task",
      }),
      expect.objectContaining({
        kind: "tool",
        text: "[tool:task:end]",
        phase: "final",
        source: "tool",
        messageID: "msg-1",
        partID: "tool-1",
        tool: "task",
      }),
    ])
  })

  test("emits tool error once", () => {
    let data = createSessionData()
    const evt = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-err",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "error",
            input: {
              command: "ls",
            },
            error: "boom",
            time: { start: 1, end: 2 },
          },
        },
      },
    }

    const first = reduce(data, evt)
    expect(first.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        text: "[tool:bash:error] boom",
        phase: "final",
        source: "tool",
        messageID: "msg-1",
        partID: "tool-err",
        tool: "bash",
      }),
    ])

    data = first.data
    const next = reduce(data, evt)
    expect(next.commits).toEqual([])
  })

  test("emits assistant message error after pending part flush", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "hello",
          time: { end: Date.now() },
        },
      },
    }).data

    const out = reduce(
      data,
      assistant("msg-1", {
        error: {
          name: "UnknownError",
          data: {
            message: "boom",
          },
        },
      }),
    )

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: "hello",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
      {
        kind: "error",
        text: "boom",
        phase: "start",
        source: "system",
        messageID: "msg-1",
      },
    ])
  })

  test("permission and question events stay footer-only with permission precedence", () => {
    let data = createSessionData()

    const perm = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        metadata: {},
        always: [],
      },
    })

    expect(perm.commits).toEqual([])
    expect(perm.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({ id: "perm-1" }),
      },
    })

    data = perm.data
    const ask = reduce(data, {
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        questions: [
          {
            question: "Mode?",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiple: false,
          },
        ],
      },
    })

    expect(ask.commits).toEqual([])
    expect(ask.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({ id: "perm-1" }),
      },
    })

    data = ask.data
    const replied = reduce(data, {
      type: "permission.replied",
      properties: {
        sessionID: "session-1",
        requestID: "perm-1",
        reply: "reject",
      },
    })

    expect(replied.commits).toEqual([])
    expect(replied.footer).toEqual({
      patch: { status: "awaiting answer" },
      view: {
        type: "question",
        request: expect.objectContaining({ id: "question-1" }),
      },
    })

    data = replied.data
    const rejected = reduce(data, {
      type: "question.rejected",
      properties: {
        sessionID: "session-1",
        requestID: "question-1",
      },
    })

    expect(rejected.commits).toEqual([])
    expect(rejected.footer).toEqual({
      patch: { status: "" },
      view: { type: "prompt" },
    })
  })

  test("enriches permission requests from matching tool input", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
              description: "Shell command",
            },
          },
        },
      },
    }).data

    const out = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    })

    expect(out.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({
          id: "perm-1",
          metadata: expect.objectContaining({
            input: {
              command: "git status --short",
              description: "Shell command",
            },
          }),
        }),
      },
    })
  })

  test("refreshes active permission view when matching tool input arrives later", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    }).data

    const out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
              description: "Shell command",
            },
          },
        },
      },
    })

    expect(out.footer).toEqual({
      view: {
        type: "permission",
        request: expect.objectContaining({
          id: "perm-1",
          metadata: expect.objectContaining({
            input: {
              command: "git status --short",
              description: "Shell command",
            },
          }),
        }),
      },
    })
  })

  test("session errors stay in transcript", () => {
    const out = reduce(createSessionData(), {
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
    })

    expect(out.commits).toEqual([
      {
        kind: "error",
        text: "permission denied",
        phase: "start",
        source: "system",
      },
    ])
  })
})
