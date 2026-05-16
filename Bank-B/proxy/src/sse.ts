import type { Response } from "express";

export class SseBus {
  private clients: Response[] = [];

  addClient(res: Response): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":\n\n");
    this.clients.push(res);
    console.log(`[sse] client connected. Total: ${this.clients.length}`);

    res.on("close", () => {
      this.clients = this.clients.filter((c) => c !== res);
      console.log(`[sse] client disconnected. Total: ${this.clients.length}`);
    });
  }

  broadcast(event: string, data: unknown): void {
    console.log(`[sse] broadcasting event: ${event}`);
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach((c) => c.write(payload));
  }
}
