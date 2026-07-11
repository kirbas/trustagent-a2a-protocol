/**
 * Register this proxy's public key with a peer (Proxy B or the independent
 * witness) so they can verify our signatures. Best-effort with retries — the
 * peer may not be up yet when we boot.
 */
async function registerWithPeer(
  peerUrl: string,
  registerPath: string,
  label: string,
  kid: string,
  publicKeyHex: string,
  retries: number
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${peerUrl}${registerPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, publicKeyHex }),
      });
      if (res.ok) {
        console.log(`[key-exchange] registered with ${label} successfully`);
        return;
      }
    } catch {
      // Peer not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`[key-exchange] failed to register with ${label} after max retries`);
}

export function registerWithProxyB(
  proxyBUrl: string,
  kid: string,
  publicKeyHex: string,
  retries = 25
): Promise<void> {
  return registerWithPeer(proxyBUrl, "/register-peer-key", "Proxy B", kid, publicKeyHex, retries);
}

/**
 * Register this proxy's public key with the independent witness (Delta #3) so
 * the witness can verify our signatures before it will co-sign a transaction.
 * Best-effort with retries — the witness holds the key registry independently
 * of both banks.
 */
export function registerWithWitness(
  witnessUrl: string,
  kid: string,
  publicKeyHex: string,
  retries = 25
): Promise<void> {
  return registerWithPeer(witnessUrl, "/register-key", "witness", kid, publicKeyHex, retries);
}
