export async function registerWithProxyB(
  proxyBUrl: string,
  kid: string,
  publicKeyHex: string,
  retries = 25
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${proxyBUrl}/register-peer-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, publicKeyHex }),
      });
      if (res.ok) {
        console.log("[key-exchange] registered with Proxy B successfully");
        return;
      }
    } catch {
      // Proxy B not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("[key-exchange] failed to register with Proxy B after max retries");
}

/**
 * Register this proxy's public key with the independent witness (Delta #3) so
 * the witness can verify our signatures before it will co-sign a transaction.
 * Best-effort with retries — the witness holds the key registry independently
 * of both banks.
 */
export async function registerWithWitness(
  witnessUrl: string,
  kid: string,
  publicKeyHex: string,
  retries = 25
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${witnessUrl}/register-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, publicKeyHex }),
      });
      if (res.ok) {
        console.log("[key-exchange] registered with witness successfully");
        return;
      }
    } catch {
      // Witness not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("[key-exchange] failed to register with witness after max retries");
}
