import { vi } from "vitest";

export function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

/**
 * Installs a global fetch mock. Each suffix in `defaultOkSuffixes` auto-succeeds
 * with `{ ok: true }` unless the caller supplies its own handler for that
 * suffix in `handlers`; everything else is dispatched to `handlers` by URL
 * suffix match, or throws if unmatched.
 */
export function installFetch(
  handlers: Record<string, (opts?: { body?: string }) => Response | Promise<Response>> = {},
  defaultOkSuffixes: string[] = ["/register-peer-key"]
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: { body?: string }) => {
      const u = String(url);
      for (const suffix of defaultOkSuffixes) {
        if (u.endsWith(suffix) && !handlers[suffix]) return jsonResponse({ ok: true });
      }
      for (const suffix of Object.keys(handlers)) {
        if (u.endsWith(suffix)) return handlers[suffix](opts);
      }
      throw new Error(`unexpected fetch to ${u}`);
    })
  );
}
