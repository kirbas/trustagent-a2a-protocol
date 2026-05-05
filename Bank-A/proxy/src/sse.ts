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
    res.on("close", () => {
      this.clients = this.clients.filter((c) => c !== res);
    });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach((c) => c.write(payload));
  }
}
