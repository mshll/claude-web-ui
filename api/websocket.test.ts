import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import { WebSocket } from "ws";
import {
  initWebSocket,
  stopWebSocket,
  getConnectedClients,
  getClientCount,
  broadcast,
  getWebSocketServer,
} from "./websocket";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("WebSocket Server", () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
    initWebSocket(httpServer);
  });

  afterEach(async () => {
    stopWebSocket();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("should initialize WebSocket server", () => {
    const wss = getWebSocketServer();
    expect(wss).toBeDefined();
  });

  it("should accept client connections", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await waitForOpen(ws);

    expect(getClientCount()).toBe(1);
    expect(getConnectedClients()).toHaveLength(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("should send connected message on connection", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const message = await waitForMessage(ws);

    expect(message).toMatchObject({
      type: "connected",
      clientId: expect.stringMatching(/^client-/),
    });

    ws.close();
  });

  it("should handle multiple clients", async () => {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);

    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    expect(getClientCount()).toBe(2);
    expect(getConnectedClients()).toHaveLength(2);

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("should remove client on disconnect", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await waitForOpen(ws);

    expect(getClientCount()).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(getClientCount()).toBe(0);
  });

  it("should broadcast message to all clients", async () => {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);

    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    const messages1: unknown[] = [];
    const messages2: unknown[] = [];

    ws1.on("message", (data) => messages1.push(JSON.parse(data.toString())));
    ws2.on("message", (data) => messages2.push(JSON.parse(data.toString())));

    await new Promise((r) => setTimeout(r, 50));

    broadcast({ type: "test", data: "hello" });

    await new Promise((r) => setTimeout(r, 50));

    const broadcastMsg1 = messages1.find((m: unknown) => (m as { type: string }).type === "test");
    const broadcastMsg2 = messages2.find((m: unknown) => (m as { type: string }).type === "test");

    expect(broadcastMsg1).toEqual({ type: "test", data: "hello" });
    expect(broadcastMsg2).toEqual({ type: "test", data: "hello" });

    ws1.close();
    ws2.close();
  });

  it("should clean up on stop", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await waitForOpen(ws);

    stopWebSocket();

    expect(getWebSocketServer()).toBeNull();
    expect(getClientCount()).toBe(0);
  });
});
