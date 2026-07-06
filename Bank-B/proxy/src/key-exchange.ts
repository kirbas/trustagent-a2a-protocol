/**
 * Register this proxy's public key with the independent witness (Delta #3).
 *
 * The witness must verify BOTH the Intent (Proxy A) and the Acceptance
 * (Proxy B) signatures before it will co-sign. Bank-B therefore registers its
 * own key with the witness at boot, from a channel the witness controls —
 * neither bank hands the witness the other's key.
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
