import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import {
  initWebSocket,
  stopWebSocket,
  getConnectedClients,
  getClientCount,
  broadcast,
  getSocketIOServer,
  setMessageHandler,
  associateClientWithSession,
  dissociateClientFromSession,
  getClientsBySession,
  getClientSession,
  sendToSession,
  getActiveSessions,
  hasSessionControl,
  getSessionController,
  requestSessionControl,
  type ClientMessage,
} from "./websocket";

function createClientSocket(port: number): ClientSocket {
  return ioClient(`http://localhost:${port}`, {
    path: "/socket.io",
    transports: ["websocket"],
    autoConnect: true,
    reconnection: false,
  });
}

function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForMessage(socket: ClientSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message timeout")), 5000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(data);
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
    const io = getSocketIOServer();
    expect(io).toBeDefined();
  });

  it("should accept client connections", async () => {
    const socket = createClientSocket(port);
    await waitForConnect(socket);

    expect(getClientCount()).toBe(1);
    expect(getConnectedClients()).toHaveLength(1);

    socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("should send connected message on connection", async () => {
    const socket = createClientSocket(port);
    const message = await waitForMessage(socket);

    expect(message).toMatchObject({
      type: "connected",
      clientId: expect.stringMatching(/^client-/),
    });

    socket.disconnect();
  });

  it("should handle multiple clients", async () => {
    const socket1 = createClientSocket(port);
    const socket2 = createClientSocket(port);

    await Promise.all([waitForConnect(socket1), waitForConnect(socket2)]);

    expect(getClientCount()).toBe(2);
    expect(getConnectedClients()).toHaveLength(2);

    socket1.disconnect();
    socket2.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("should remove client on disconnect", async () => {
    const socket = createClientSocket(port);
    await waitForConnect(socket);

    expect(getClientCount()).toBe(1);

    socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    expect(getClientCount()).toBe(0);
  });

  it("should broadcast message to all clients", async () => {
    const socket1 = createClientSocket(port);
    const socket2 = createClientSocket(port);

    await Promise.all([waitForConnect(socket1), waitForConnect(socket2)]);

    const messages1: unknown[] = [];
    const messages2: unknown[] = [];

    socket1.on("message", (data) => messages1.push(data));
    socket2.on("message", (data) => messages2.push(data));

    await new Promise((r) => setTimeout(r, 50));

    broadcast({ type: "test", data: "hello" });

    await new Promise((r) => setTimeout(r, 50));

    const broadcastMsg1 = messages1.find((m: unknown) => (m as { type: string }).type === "test");
    const broadcastMsg2 = messages2.find((m: unknown) => (m as { type: string }).type === "test");

    expect(broadcastMsg1).toEqual({ type: "test", data: "hello" });
    expect(broadcastMsg2).toEqual({ type: "test", data: "hello" });

    socket1.disconnect();
    socket2.disconnect();
  });

  it("should clean up on stop", async () => {
    const socket = createClientSocket(port);
    await waitForConnect(socket);

    stopWebSocket();

    expect(getSocketIOServer()).toBeNull();
    expect(getClientCount()).toBe(0);
  });

  describe("message handling", () => {
    it("should call message handler with parsed message", async () => {
      const handler = vi.fn();
      setMessageHandler(handler);

      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      const testMessage: ClientMessage = {
        type: "session.start",
        sessionId: "test-session",
      };

      socket.emit("message", testMessage);
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledWith(clientId, testMessage);
      socket.disconnect();
    });

    it("should send error for message without type", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(data));

      await new Promise((r) => setTimeout(r, 50));

      socket.emit("message", { foo: "bar" });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Message must have a type",
      });

      socket.disconnect();
    });

    it("should send error when handler throws", async () => {
      setMessageHandler(() => {
        throw new Error("Handler failed");
      });

      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(data));

      await new Promise((r) => setTimeout(r, 50));

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Handler failed",
      });

      socket.disconnect();
    });
  });

  describe("session-client association", () => {
    it("should associate client with session", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      const result = associateClientWithSession(clientId, "session-1");

      expect(result).toBe(true);
      expect(getClientSession(clientId)).toBe("session-1");
      expect(getClientsBySession("session-1")).toContain(clientId);
      expect(getActiveSessions()).toContain("session-1");

      socket.disconnect();
    });

    it("should return false for non-existent client", () => {
      const result = associateClientWithSession("fake-client", "session-1");
      expect(result).toBe(false);
    });

    it("should handle multiple clients in same session", async () => {
      const socket1 = createClientSocket(port);
      const socket2 = createClientSocket(port);

      await Promise.all([waitForConnect(socket1), waitForConnect(socket2)]);

      const [clientId1, clientId2] = getConnectedClients();
      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");

      const sessionClients = getClientsBySession("session-1");
      expect(sessionClients).toHaveLength(2);
      expect(sessionClients).toContain(clientId1);
      expect(sessionClients).toContain(clientId2);

      socket1.disconnect();
      socket2.disconnect();
    });

    it("should move client to new session when re-associated", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");
      associateClientWithSession(clientId, "session-2");

      expect(getClientSession(clientId)).toBe("session-2");
      expect(getClientsBySession("session-1")).not.toContain(clientId);
      expect(getClientsBySession("session-2")).toContain(clientId);
      expect(getActiveSessions()).not.toContain("session-1");

      socket.disconnect();
    });

    it("should dissociate client from session", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");
      const result = dissociateClientFromSession(clientId);

      expect(result).toBe(true);
      expect(getClientSession(clientId)).toBeUndefined();
      expect(getClientsBySession("session-1")).not.toContain(clientId);

      socket.disconnect();
    });

    it("should return false when dissociating client not in session", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      const result = dissociateClientFromSession(clientId);

      expect(result).toBe(false);

      socket.disconnect();
    });

    it("should clean up session association on disconnect", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");

      socket.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      expect(getClientsBySession("session-1")).toHaveLength(0);
      expect(getActiveSessions()).not.toContain("session-1");
    });
  });

  describe("sendToSession", () => {
    it("should send message to all clients in session", async () => {
      const socket1 = createClientSocket(port);
      const socket2 = createClientSocket(port);
      const socket3 = createClientSocket(port);

      const [msg1, msg2, msg3] = await Promise.all([
        waitForMessage(socket1),
        waitForMessage(socket2),
        waitForMessage(socket3),
      ]) as Array<{ type: string; clientId: string }>;

      const clientId1 = msg1.clientId;
      const clientId2 = msg2.clientId;
      const clientId3 = msg3.clientId;

      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");
      associateClientWithSession(clientId3, "session-2");

      const messages1: unknown[] = [];
      const messages2: unknown[] = [];
      const messages3: unknown[] = [];

      socket1.on("message", (data) => messages1.push(data));
      socket2.on("message", (data) => messages2.push(data));
      socket3.on("message", (data) => messages3.push(data));

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

      socket1.disconnect();
      socket2.disconnect();
      socket3.disconnect();
    });

    it("should return 0 for non-existent session", () => {
      const sentCount = sendToSession("fake-session", {
        type: "test",
        data: "hello",
      });
      expect(sentCount).toBe(0);
    });
  });

  describe("ping/pong", () => {
    it("should respond to ping with pong", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(data));

      await new Promise((r) => setTimeout(r, 50));

      socket.emit("message", { type: "ping" });
      await new Promise((r) => setTimeout(r, 50));

      const pongMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "pong"
      );
      expect(pongMsg).toMatchObject({ type: "pong" });

      socket.disconnect();
    });
  });

  describe("session control", () => {
    it("should give control to first client associating with session", async () => {
      const socket = createClientSocket(port);
      await waitForConnect(socket);

      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(data));

      await new Promise((r) => setTimeout(r, 50));

      const clientId = getConnectedClients()[0];
      associateClientWithSession(clientId, "session-1");

      await new Promise((r) => setTimeout(r, 50));

      const controlMsg = messages.find(
        (m: unknown) => (m as { type: string }).type === "session.control"
      );
      expect(controlMsg).toMatchObject({
        type: "session.control",
        hasControl: true,
      });
      expect(hasSessionControl(clientId, "session-1")).toBe(true);
      expect(getSessionController("session-1")).toBe(clientId);

      socket.disconnect();
    });

    it("should not give control to subsequent clients", async () => {
      const socket1 = createClientSocket(port);
      const socket2 = createClientSocket(port);

      const [msg1, msg2] = await Promise.all([
        waitForMessage(socket1),
        waitForMessage(socket2),
      ]) as Array<{ type: string; clientId: string }>;

      const clientId1 = msg1.clientId;
      const clientId2 = msg2.clientId;

      const messages2: unknown[] = [];
      socket2.on("message", (data) => messages2.push(data));

      associateClientWithSession(clientId1, "session-1");

      await new Promise((r) => setTimeout(r, 50));

      associateClientWithSession(clientId2, "session-1");

      await new Promise((r) => setTimeout(r, 50));

      const controlMsg = messages2.find(
        (m: unknown) => (m as { type: string }).type === "session.control"
      );
      expect(controlMsg).toMatchObject({
        type: "session.control",
        hasControl: false,
      });
      expect(hasSessionControl(clientId2, "session-1")).toBe(false);
      expect(getSessionController("session-1")).toBe(clientId1);

      socket1.disconnect();
      socket2.disconnect();
    });

    it("should transfer control when controller disconnects", async () => {
      const socket1 = createClientSocket(port);
      const socket2 = createClientSocket(port);

      const [msg1, msg2] = await Promise.all([
        waitForMessage(socket1),
        waitForMessage(socket2),
      ]) as Array<{ type: string; clientId: string }>;

      const clientId1 = msg1.clientId;
      const clientId2 = msg2.clientId;

      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");

      const messages2: unknown[] = [];
      socket2.on("message", (data) => messages2.push(data));

      await new Promise((r) => setTimeout(r, 50));

      socket1.disconnect();

      await new Promise((r) => setTimeout(r, 100));

      const controlMsg = messages2.find(
        (m: unknown) =>
          (m as { type: string; hasControl?: boolean }).type === "session.control" &&
          (m as { hasControl?: boolean }).hasControl === true
      );
      expect(controlMsg).toMatchObject({
        type: "session.control",
        hasControl: true,
      });
      expect(getSessionController("session-1")).toBe(clientId2);

      socket2.disconnect();
    });

    it("should allow requesting control transfer", async () => {
      const socket1 = createClientSocket(port);
      const socket2 = createClientSocket(port);

      const [msg1, msg2] = await Promise.all([
        waitForMessage(socket1),
        waitForMessage(socket2),
      ]) as Array<{ type: string; clientId: string }>;

      const clientId1 = msg1.clientId;
      const clientId2 = msg2.clientId;

      associateClientWithSession(clientId1, "session-1");
      associateClientWithSession(clientId2, "session-1");

      const messages1: unknown[] = [];
      const messages2: unknown[] = [];
      socket1.on("message", (data) => messages1.push(data));
      socket2.on("message", (data) => messages2.push(data));

      await new Promise((r) => setTimeout(r, 50));

      const result = requestSessionControl(clientId2, "session-1");

      await new Promise((r) => setTimeout(r, 50));

      expect(result).toBe(true);
      expect(getSessionController("session-1")).toBe(clientId2);

      const lostControl = messages1.find(
        (m: unknown) =>
          (m as { type: string; hasControl?: boolean }).type === "session.control" &&
          (m as { hasControl?: boolean }).hasControl === false
      );
      const gainedControl = messages2.find(
        (m: unknown) =>
          (m as { type: string; hasControl?: boolean }).type === "session.control" &&
          (m as { hasControl?: boolean }).hasControl === true
      );

      expect(lostControl).toBeDefined();
      expect(gainedControl).toBeDefined();

      socket1.disconnect();
      socket2.disconnect();
    });

    it("should return false for requestSessionControl with non-existent client", () => {
      const result = requestSessionControl("fake-client", "session-1");
      expect(result).toBe(false);
    });
  });
});
