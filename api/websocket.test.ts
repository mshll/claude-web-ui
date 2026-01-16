import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { WebSocket } from "ws";
import {
  initWebSocket,
  stopWebSocket,
  getConnectedClients,
  getClientCount,
  broadcast,
  getWebSocketServer,
  setMessageHandler,
  associateClientWithSession,
  dissociateClientFromSession,
  getClientsBySession,
  getClientSession,
  sendToSession,
  getActiveSessions,
  type ClientMessage,
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

  describe("message handling", () => {
    it("should call message handler with parsed message", async () => {
      const handler = vi.fn();
      setMessageHandler(handler);

      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      const testMessage: ClientMessage = {
        type: "session.start",
        sessionId: "test-session",
      };

      ws.send(JSON.stringify(testMessage));
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledWith(clientId, testMessage);
      ws.close();
    });

    it("should send error for invalid JSON", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const messages: unknown[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

      await new Promise((r) => setTimeout(r, 50));

      ws.send("not valid json");
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Invalid JSON message",
      });

      ws.close();
    });

    it("should send error for message without type", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const messages: unknown[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ foo: "bar" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Message must have a type",
      });

      ws.close();
    });

    it("should send error when handler throws", async () => {
      setMessageHandler(() => {
        throw new Error("Handler failed");
      });

      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const messages: unknown[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Handler failed",
      });

      ws.close();
    });
  });

  describe("session-client association", () => {
    it("should associate client with session", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      const result = associateClientWithSession(clientId, "session-1");

      expect(result).toBe(true);
      expect(getClientSession(clientId)).toBe("session-1");
      expect(getClientsBySession("session-1")).toContain(clientId);
      expect(getActiveSessions()).toContain("session-1");

      ws.close();
    });

    it("should return false for non-existent client", () => {
      const result = associateClientWithSession("fake-client", "session-1");
      expect(result).toBe(false);
    });

    it("should handle multiple clients in same session", async () => {
      const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
      const ws2 = new WebSocket(`ws://localhost:${port}/ws`);

      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

      const [clientId1, clientId2] = getConnectedClients();
      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");

      const sessionClients = getClientsBySession("session-1");
      expect(sessionClients).toHaveLength(2);
      expect(sessionClients).toContain(clientId1);
      expect(sessionClients).toContain(clientId2);

      ws1.close();
      ws2.close();
    });

    it("should move client to new session when re-associated", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");
      associateClientWithSession(clientId, "session-2");

      expect(getClientSession(clientId)).toBe("session-2");
      expect(getClientsBySession("session-1")).not.toContain(clientId);
      expect(getClientsBySession("session-2")).toContain(clientId);
      expect(getActiveSessions()).not.toContain("session-1");

      ws.close();
    });

    it("should dissociate client from session", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");
      const result = dissociateClientFromSession(clientId);

      expect(result).toBe(true);
      expect(getClientSession(clientId)).toBeUndefined();
      expect(getClientsBySession("session-1")).not.toContain(clientId);

      ws.close();
    });

    it("should return false when dissociating client not in session", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      const result = dissociateClientFromSession(clientId);

      expect(result).toBe(false);

      ws.close();
    });

    it("should clean up session association on disconnect", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(ws);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");

      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(getClientsBySession("session-1")).toHaveLength(0);
      expect(getActiveSessions()).not.toContain("session-1");
    });
  });

  describe("sendToSession", () => {
    it("should send message to all clients in session", async () => {
      const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
      const ws2 = new WebSocket(`ws://localhost:${port}/ws`);
      const ws3 = new WebSocket(`ws://localhost:${port}/ws`);

      await Promise.all([waitForOpen(ws1), waitForOpen(ws2), waitForOpen(ws3)]);

      const [clientId1, clientId2, clientId3] = getConnectedClients();
      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");
      associateClientWithSession(clientId3, "session-2");

      const messages1: unknown[] = [];
      const messages2: unknown[] = [];
      const messages3: unknown[] = [];

      ws1.on("message", (data) => messages1.push(JSON.parse(data.toString())));
      ws2.on("message", (data) => messages2.push(JSON.parse(data.toString())));
      ws3.on("message", (data) => messages3.push(JSON.parse(data.toString())));

      await new Promise((r) => setTimeout(r, 50));

      const sentCount = sendToSession("session-1", {
        type: "test",
        data: "session message",
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(sentCount).toBe(2);

      const testMsg1 = messages1.find(
        (m: unknown) => (m as { type: string }).type === "test"
      );
      const testMsg2 = messages2.find(
        (m: unknown) => (m as { type: string }).type === "test"
      );
      const testMsg3 = messages3.find(
        (m: unknown) => (m as { type: string }).type === "test"
      );

      expect(testMsg1).toEqual({ type: "test", data: "session message" });
      expect(testMsg2).toEqual({ type: "test", data: "session message" });
      expect(testMsg3).toBeUndefined();

      ws1.close();
      ws2.close();
      ws3.close();
    });

    it("should return 0 for non-existent session", () => {
      const sentCount = sendToSession("fake-session", {
        type: "test",
        data: "hello",
      });
      expect(sentCount).toBe(0);
    });
  });
});
