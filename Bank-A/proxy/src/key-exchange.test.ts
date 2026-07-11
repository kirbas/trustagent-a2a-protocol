import { describe, it, expect, vi, afterEach } from "vitest";
import { registerWithProxyB, registerWithWitness } from "./key-exchange.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(ok: boolean): Response {
  return { ok, status: ok ? 200 : 400, json: async () => ({}) } as unknown as Response;
}

describe("registerWithProxyB", () => {
  it("resolves on the first successful call to /register-peer-key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerWithProxyB("http://proxy-b.test", "kid-1", "hex-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://proxy-b.test/register-peer-key",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ kid: "kid-1", publicKeyHex: "hex-1" });
  });

  it("retries after a non-ok response and eventually succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(false))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const result = registerWithProxyB("http://proxy-b.test", "kid-1", "hex-1", 3);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a thrown fetch error and eventually succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const result = registerWithProxyB("http://proxy-b.test", "kid-1", "hex-1", 3);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(false));
    vi.stubGlobal("fetch", fetchMock);

    const assertion = expect(
      registerWithProxyB("http://proxy-b.test", "kid-1", "hex-1", 2)
    ).rejects.toThrow(/failed to register with Proxy B/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("registerWithWitness", () => {
  it("posts to /register-key and resolves on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerWithWitness("http://witness.test", "kid-1", "hex-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://witness.test/register-key",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws after exhausting all retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(false));
    vi.stubGlobal("fetch", fetchMock);

    const assertion = expect(
      registerWithWitness("http://witness.test", "kid-1", "hex-1", 2)
    ).rejects.toThrow(/failed to register with witness/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
