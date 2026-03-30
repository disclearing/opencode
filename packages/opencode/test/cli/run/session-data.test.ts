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

describe("session data reducer", () => {
  test("repeated finalized part commits once", () => {
    const evt = {
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
    }

    let data = createSessionData()
    const first = reduce(data, evt)
    expect(first.commits).toEqual([{ kind: "assistant", text: "assistant reply" }])

    data = first.data
    const next = reduce(data, evt)
    expect(next.commits).toEqual([])
  })

  test("delta then final update emits one commit", () => {
    let data = createSessionData()

    const delta = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "from delta",
      },
    })

    data = delta.data
    const final = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          sessionID: "session-1",
          type: "text",
          text: "",
          time: { end: Date.now() },
        },
      },
    })

    expect(final.commits).toEqual([{ kind: "assistant", text: "from delta" }])
  })

  test("duplicate deltas keep finalized text", () => {
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

    const out = reduce(data, {
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
    })

    expect(out.commits).toEqual([{ kind: "assistant", text: "hello" }])
  })

  test("ignores non-text deltas", () => {
    const out = reduce(createSessionData(), {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "input",
        delta: "ignored",
      },
    })

    expect(out.commits).toEqual([])
    expect(out.data.delta.size).toBe(0)
  })

  test("ignores stale deltas after part finalized", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          sessionID: "session-1",
          type: "text",
          text: "done",
          time: { end: Date.now() },
        },
      },
    }).data

    const out = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "late",
      },
    })

    expect(out.commits).toEqual([])
    expect(out.data.delta.size).toBe(0)
  })

  test("tool running then completed success stays status-only", () => {
    let data = createSessionData()

    const running = reduce(data, {
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
    })

    expect(running.commits).toEqual([])
    expect(running.status).toBe("running investigate")

    data = running.data
    const done = reduce(data, {
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
            title: "task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    })

    expect(done.commits).toEqual([])
  })

  test("replayed running tool after completion is ignored", () => {
    let data = createSessionData()

    data = reduce(data, {
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
    }).data

    data = reduce(data, {
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
            title: "task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    }).data

    const out = reduce(data, {
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
    })

    expect(out.status).toBeUndefined()
    expect(out.commits).toEqual([])
  })

  test("tool error emits one commit", () => {
    let data = createSessionData()

    const evt = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-err",
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
    expect(first.commits).toEqual([{ kind: "error", text: "bash: boom" }])

    data = first.data
    const next = reduce(data, evt)
    expect(next.commits).toEqual([])
  })

  test("reasoning commits as reasoning kind", () => {
    const out = reduce(
      createSessionData(),
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reason-1",
            sessionID: "session-1",
            type: "reasoning",
            text: "step",
            time: { start: 1, end: 2 },
          },
        },
      },
      true,
    )

    expect(out.commits).toEqual([{ kind: "reasoning", text: "step" }])
  })

  test("thinking disabled clears finalized reasoning delta", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "reason-1",
        field: "text",
        delta: "hidden",
      },
    }).data

    expect(data.delta.size).toBe(1)

    const out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "reason-1",
          sessionID: "session-1",
          type: "reasoning",
          text: "",
          time: { start: 1, end: 2 },
        },
      },
    })

    expect(out.commits).toEqual([])
    expect(out.data.delta.size).toBe(0)
  })

  test("permission asked updates status only", () => {
    const out = reduce(createSessionData(), {
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

    expect(out.commits).toEqual([])
    expect(out.status).toBe("permission requested: read (/tmp/file.txt); auto-rejecting")
  })

  test("other-session events are ignored", () => {
    const data = createSessionData()
    const out = reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "other",
        info: {
          role: "assistant",
          agent: "agent",
          modelID: "model",
          providerID: "provider",
          tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
          cost: 0,
        },
      },
    })

    expect(out.commits).toEqual([])
    expect(out.status).toBeUndefined()
    expect(out.usage).toBeUndefined()
    expect(out.data.announced).toBe(false)
  })
})
