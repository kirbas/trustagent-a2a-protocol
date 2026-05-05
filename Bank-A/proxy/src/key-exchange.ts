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
