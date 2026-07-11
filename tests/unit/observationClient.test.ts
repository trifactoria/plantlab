import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservation, deleteObservation, updateObservation } from "../../src/lib/observationClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("observationClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createObservation resolves ok with the created event on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "evt-1", type: "Germinated" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createObservation({ plantId: "p1", type: "Germinated" });

    expect(result).toEqual({ ok: true, data: { id: "evt-1", type: "Germinated" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("createObservation surfaces warnings on 409 without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, { warnings: ["This plant already has this milestone."] })));

    const result = await createObservation({ plantId: "p1", milestoneId: "m1" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ warnings: ["This plant already has this milestone."] });
  });

  it("createObservation surfaces a generic error on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "type is required" })));

    const result = await createObservation({ plantId: "p1" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "type is required" });
  });

  it("updateObservation PATCHes the given event id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "evt-1", notes: "updated" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateObservation("evt-1", { notes: "updated" });

    expect(result).toEqual({ ok: true, data: { id: "evt-1", notes: "updated" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/events/evt-1", expect.objectContaining({ method: "PATCH" }));
  });

  it("deleteObservation resolves ok on success and error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(deleteObservation("evt-1")).resolves.toEqual({ ok: true });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "Origin events cannot be deleted." })));
    await expect(deleteObservation("evt-2")).resolves.toEqual({
      ok: false,
      error: "Origin events cannot be deleted.",
    });
  });
});
