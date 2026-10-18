import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type FormInfo, type OpenCodeEvent } from "../src/promise"

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

const location = { directory: "/project" }
const form = (sessionID: string, id: string): FormInfo => ({
  id,
  sessionID,
  title: "Choose an answer",
  fields: [{ type: "string", key: "answer", title: "Answer", required: true }],
})

test.each(["ses_forms", "global"])(
  "%s form hydration retains a concurrent creation and snapshot forms",
  async (sessionID) => {
    const response = Promise.withResolvers<Response>()
    const requested = Promise.withResolvers<void>()
    const setup = fixture(() => {
      requested.resolve()
      return response.promise
    })
    try {
      const reading = setup.data.session.form.sync(sessionID, location)
      await requested.promise
      setup.emit({
        id: "evt_form_created",
        type: "form.created",
        created: 1,
        location,
        data: { form: form(sessionID, "frm_live") },
      })
      expect(setup.data.session.form.list(sessionID, location)?.map((item) => item.id)).toEqual(["frm_live"])
      response.resolve(Response.json({ data: [form(sessionID, "frm_snapshot")], location }))
      await reading
      expect(setup.data.session.form.list(sessionID, location)?.map((item) => item.id)).toEqual([
        "frm_snapshot",
        "frm_live",
      ])
    } finally {
      response.resolve(Response.json({ data: [], location }))
      setup.dispose()
    }
  },
)

test.each([
  ["ses_forms", "replied"],
  ["ses_forms", "cancelled"],
  ["global", "replied"],
  ["global", "cancelled"],
] as const)("%s form hydration cannot resurrect a %s form", async (sessionID, action) => {
  const response = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const setup = fixture(() => {
    requested.resolve()
    return response.promise
  })
  try {
    const reading = setup.data.session.form.sync(sessionID, location)
    await requested.promise
    setup.emit({
      id: "evt_form_settled",
      type: `form.${action}`,
      created: 2,
      location,
      data: { sessionID, id: "frm_settled", ...(action === "replied" ? { answer: { answer: "yes" } } : {}) },
    })
    response.resolve(
      Response.json({ data: [form(sessionID, "frm_settled"), form(sessionID, "frm_snapshot")], location }),
    )
    await reading
    expect(setup.data.session.form.list(sessionID, location)?.map((item) => item.id)).toEqual(["frm_snapshot"])
  } finally {
    response.resolve(Response.json({ data: [], location }))
    setup.dispose()
  }
})

test("failed form hydration does not retain event overrides for the next snapshot", async () => {
  const response = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const responses = [response.promise, Promise.resolve(Response.json({ data: [] }))]
  const setup = fixture(() => {
    requested.resolve()
    return responses.shift() ?? Promise.reject(new Error("Unexpected form read"))
  })
  try {
    const reading = setup.data.session.form.sync("ses_forms")
    await requested.promise
    setup.emit({
      id: "evt_form_created",
      type: "form.created",
      created: 1,
      location,
      data: { form: form("ses_forms", "frm_live") },
    })
    response.resolve(new Response(null, { status: 503 }))
    await expect(reading).rejects.toBeDefined()
    setup.data.session.form.invalidate("ses_forms")
    // A new successful snapshot can remove forms without replaying the failed read's events.
    await setup.data.session.form.sync("ses_forms")
    expect(setup.data.session.form.list("ses_forms")).toEqual([])
  } finally {
    response.resolve(Response.json({ data: [] }))
    setup.dispose()
  }
})
