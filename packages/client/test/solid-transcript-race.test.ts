import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo, type SessionMessageInfo } from "../src/promise"

const session: SessionInfo = {
  id: "ses_transcript",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 0 },
  location: { directory: "/project" },
}
const user: SessionMessageInfo = { id: "msg_user", type: "user", text: "Continue", time: { created: 1 } }
const assistant: SessionMessageInfo = {
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  content: [],
  time: { created: 2 },
}

function fixture(fetch: (request: Request) => Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: (input, init) => fetch(input instanceof Request ? input : new Request(input, init)),
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    emit: (event: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: event.type, details: event })),
    dispose,
  }))
}

test.each(["missing", "stale"] as const)(
  "transcript hydration preserves a live assistant over a %s snapshot",
  async (snapshot) => {
    const response = Promise.withResolvers<Response>()
    const requested = Promise.withResolvers<void>()
    const setup = fixture((request) => {
      if (new URL(request.url).pathname.endsWith("/message")) {
        requested.resolve()
        return response.promise
      }
      return Promise.resolve(Response.json(session))
    })
    const text = () => {
      const message = setup.data.session.message.get(session.id, assistant.id)
      return message?.type === "assistant"
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : undefined
    }
    try {
      setup.data.session.remember(session)
      const reading = setup.data.session.message.sync(session.id)
      await requested.promise
      setup.emit({
        id: "evt_step",
        type: "session.step.started",
        created: 2,
        data: {
          sessionID: session.id,
          assistantMessageID: assistant.id,
          agent: "build",
          model: assistant.model,
          started: 2,
        },
      })
      setup.emit({
        id: "evt_text",
        type: "session.text.started",
        created: 3,
        data: { sessionID: session.id, assistantMessageID: assistant.id, ordinal: 0 },
      })
      setup.emit({
        id: "evt_delta",
        type: "session.text.delta",
        created: 4,
        data: { sessionID: session.id, assistantMessageID: assistant.id, ordinal: 0, delta: "Hello" },
      })
      expect(text()).toEqual(["Hello"])
      response.resolve(
        Response.json({ data: snapshot === "stale" ? [assistant, user] : [user], cursor: { next: "older" } }),
      )
      await reading
      expect(text()).toEqual(["Hello"])
      setup.emit({
        id: "evt_ended",
        type: "session.text.ended",
        created: 5,
        data: { sessionID: session.id, assistantMessageID: assistant.id, ordinal: 0, text: "Hello world" },
      })
      setup.emit({
        id: "evt_step_ended",
        type: "session.step.ended",
        created: 6,
        data: {
          sessionID: session.id,
          assistantMessageID: assistant.id,
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
      expect(text()).toEqual(["Hello world"])
      const completed = setup.data.session.message.get(session.id, assistant.id)
      expect(completed?.type === "assistant" && completed.finish).toBe("stop")
      expect(completed?.time.completed).toBe(6)
      expect(setup.data.session.message.list(session.id).map((item) => item.id)).toEqual([user.id, assistant.id])
      expect(setup.data.session.message.more(session.id)).toBe(true)
    } finally {
      response.resolve(Response.json({ data: [], cursor: {} }))
      setup.dispose()
    }
  },
)

test("transcript hydration cannot resurrect an input cancelled during the read", async () => {
  const response = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const setup = fixture(() => {
    requested.resolve()
    return response.promise
  })
  try {
    setup.emit({
      id: "evt_admitted",
      type: "session.inbox.enqueued",
      created: 1,
      data: {
        sessionID: session.id,
        inboxID: user.id,
        item: { type: "user", delivery: "steer", payload: { text: "Continue" } },
      },
    })
    const reading = setup.data.session.message.sync(session.id)
    await requested.promise
    setup.emit({
      id: "evt_cancelled",
      type: "session.inbox.cancelled",
      created: 2,
      data: { sessionID: session.id, inboxID: user.id },
    })
    response.resolve(Response.json({ data: [user], cursor: {} }))
    await reading
    expect(setup.data.session.message.get(session.id, user.id)).toBeUndefined()
    expect(setup.data.session.message.list(session.id)).toEqual([])
  } finally {
    response.resolve(Response.json({ data: [], cursor: {} }))
    setup.dispose()
  }
})

test("a transcript read without concurrent events replaces older cached content", async () => {
  const responses = ["old", "new"].map((text) => Response.json({ data: [{ ...user, text }], cursor: {} }))
  const setup = fixture(() => Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })))
  try {
    await setup.data.session.message.sync(session.id)
    setup.data.session.message.invalidate(session.id)
    await setup.data.session.message.sync(session.id)
    const current = setup.data.session.message.get(session.id, user.id)
    expect(current?.type === "user" && current.text).toBe("new")
    expect(setup.data.session.message.list(session.id).length).toBe(1)
  } finally {
    setup.dispose()
  }
})
