import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import {
  initWebSocket,
  stopWebSocket,
  setMessageHandler,
  getConnectedClients,
} from "./websocket";
import {
  handleSessionMessage,
  cleanupSessionHandler,
  getClientProcessId,
  getProcessClientId,
} from "./session-handler";
import * as processManager from "./process-manager";

vi.mock("./process-manager", () => {
  const outputHandlers: processManager.OutputHandler[] = [];
  let processCounter = 0;
  const processes = new Map<string, { id: string; sessionId?: string }>();

  return {
    spawnClaudeProcess: vi.fn((options: processManager.ProcessOptions) => {
      processCounter++;
      const id = `mock-proc-${processCounter}`;
      const info = {
        id,
        process: {} as processManager.ProcessInfo["process"],
        sessionId: options.sessionId,
        projectPath: options.projectPath,
        startedAt: Date.now(),
        status: "running" as const,
      };
      processes.set(id, info);
      return info;
    }),
    sendToProcess: vi.fn((processId: string, _message: string) => {
      return processes.has(processId);
    }),
    interruptProcess: vi.fn((processId: string) => {
      return processes.has(processId);
    }),
    killProcess: vi.fn((processId: string) => {
      const existed = processes.has(processId);
      processes.delete(processId);
      return existed;
    }),
    onProcessOutput: vi.fn((handler: processManager.OutputHandler) => {
      outputHandlers.push(handler);
    }),
    offProcessOutput: vi.fn((handler: processManager.OutputHandler) => {
      const idx = outputHandlers.indexOf(handler);
      if (idx !== -1) outputHandlers.splice(idx, 1);
    }),
    getActiveProcesses: vi.fn(() => Array.from(processes.values())),
    __emitOutput: (processId: string, output: processManager.ProcessOutput) => {
      for (const handler of outputHandlers) {
        handler(processId, output);
      }
    },
    __clearProcesses: () => {
      processes.clear();
      processCounter = 0;
    },
    __getProcesses: () => processes,
  };
});

const mockProcessManager = processManager as unknown as {
  spawnClaudeProcess: ReturnType<typeof vi.fn>;
  sendToProcess: ReturnType<typeof vi.fn>;
  interruptProcess: ReturnType<typeof vi.fn>;
  killProcess: ReturnType<typeof vi.fn>;
  onProcessOutput: ReturnType<typeof vi.fn>;
  offProcessOutput: ReturnType<typeof vi.fn>;
  __emitOutput: (processId: string, output: processManager.ProcessOutput) => void;
  __clearProcesses: () => void;
  __getProcesses: () => Map<string, { id: string; sessionId?: string }>;
};

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

function collectMessages(socket: ClientSocket): unknown[] {
  const messages: unknown[] = [];
  socket.on("message", (data) => {
    messages.push(data);
  });
  return messages;
}

describe("Session Handler - Message Round-Trip", () => {
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
    setMessageHandler(handleSessionMessage);
    mockProcessManager.__clearProcesses();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    cleanupSessionHandler();
    stopWebSocket();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  describe("session.start", () => {
    it("should spawn a Claude process and return session.started", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      const messages = collectMessages(socket);

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledTimes(1);

      const startedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.started"
      );
      expect(startedMsg).toBeDefined();

      socket.disconnect();
    });

    it("should pass sessionId to spawnClaudeProcess for resume", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      socket.emit("message", { type: "session.start", sessionId: "test-session-123" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledWith({
        sessionId: "test-session-123",
        projectPath: undefined,
        dangerouslySkipPermissions: undefined,
      });

      socket.disconnect();
    });

    it("should pass projectPath to spawnClaudeProcess", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      socket.emit("message", {
        type: "session.start",
        projectPath: "/path/to/project",
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledWith({
        sessionId: undefined,
        projectPath: "/path/to/project",
        dangerouslySkipPermissions: undefined,
      });

      socket.disconnect();
    });

    it("should track client-process association", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      expect(processId).toBeDefined();
      expect(processId).toMatch(/^mock-proc-/);

      expect(getProcessClientId(processId!)).toBe(clientId);

      socket.disconnect();
    });

    it("should kill existing process when starting new session", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const firstProcessId = getClientProcessId(clientId);

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.killProcess).toHaveBeenCalledWith(firstProcessId);

      const secondProcessId = getClientProcessId(clientId);
      expect(secondProcessId).not.toBe(firstProcessId);

      socket.disconnect();
    });
  });

  describe("message.send", () => {
    it("should send message to process stdin", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      socket.emit("message", { type: "message.send", content: "Hello Claude" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.sendToProcess).toHaveBeenCalledWith(
        expect.stringMatching(/^mock-proc-/),
        JSON.stringify({ type: "user", message: { role: "user", content: "Hello Claude" } })
      );

      socket.disconnect();
    });

    it("should return error when no session is active", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      const messages = collectMessages(socket);

      socket.emit("message", { type: "message.send", content: "Hello" });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "No active session. Start a session first.",
      });

      socket.disconnect();
    });

    it("should return error when content is missing", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const messages = collectMessages(socket);

      socket.emit("message", { type: "message.send" });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Message content is required",
      });

      socket.disconnect();
    });
  });

  describe("session.interrupt", () => {
    it("should send SIGINT to the process", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);

      socket.emit("message", { type: "session.interrupt" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.interruptProcess).toHaveBeenCalledWith(processId);

      socket.disconnect();
    });

    it("should return error when no session is active", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);

      const messages = collectMessages(socket);

      socket.emit("message", { type: "session.interrupt" });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "No active session to interrupt",
      });

      socket.disconnect();
    });
  });

  describe("session.close", () => {
    it("should kill the process and send session.ended", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(socket);

      socket.emit("message", { type: "session.close" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.killProcess).toHaveBeenCalledWith(processId);

      const endedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.ended"
      );
      expect(endedMsg).toMatchObject({
        type: "session.ended",
        reason: "Session closed by user",
      });

      expect(getClientProcessId(clientId)).toBeUndefined();

      socket.disconnect();
    });
  });

  describe("process output forwarding", () => {
    it("should forward stdout as assistant.chunk", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(socket);

      mockProcessManager.__emitOutput(processId!, {
        type: "stdout",
        data: '{"type":"assistant","content":[{"type":"text","text":"Hello!"}]}',
      });
      await new Promise((r) => setTimeout(r, 50));

      const chunkMsg = messages.find(
        (m) => (m as { type: string }).type === "assistant.chunk"
      );
      expect(chunkMsg).toMatchObject({
        type: "assistant.chunk",
        content: '{"type":"assistant","content":[{"type":"text","text":"Hello!"}]}',
      });

      socket.disconnect();
    });

    it("should forward process exit as session.ended", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(socket);

      mockProcessManager.__emitOutput(processId!, {
        type: "exit",
        code: 0,
      });
      await new Promise((r) => setTimeout(r, 50));

      const endedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.ended"
      );
      expect(endedMsg).toMatchObject({
        type: "session.ended",
        reason: "Exit code: 0",
      });

      expect(getClientProcessId(clientId)).toBeUndefined();

      socket.disconnect();
    });

    it("should forward process error as error message", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(socket);

      mockProcessManager.__emitOutput(processId!, {
        type: "error",
        error: "spawn ENOENT",
      });
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "spawn ENOENT",
      });

      socket.disconnect();
    });
  });

  describe("full message round-trip", () => {
    it("should complete a full send-receive cycle", async () => {
      const socket = createClientSocket(port);
      await waitForMessage(socket);
      const clientId = getConnectedClients()[0];

      const messages = collectMessages(socket);

      socket.emit("message", { type: "session.start" });
      await new Promise((r) => setTimeout(r, 50));

      const startedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.started"
      );
      expect(startedMsg).toBeDefined();

      const processId = getClientProcessId(clientId);

      socket.emit("message", { type: "message.send", content: "What is 2+2?" });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.sendToProcess).toHaveBeenCalledWith(
        processId,
        JSON.stringify({ type: "user", message: { role: "user", content: "What is 2+2?" } })
      );

      mockProcessManager.__emitOutput(processId!, {
        type: "stdout",
        data: '{"type":"assistant","content":[{"type":"text","text":"4"}]}',
      });
      await new Promise((r) => setTimeout(r, 50));

      const chunkMsg = messages.find(
        (m) => (m as { type: string }).type === "assistant.chunk"
      );
      expect(chunkMsg).toBeDefined();

      socket.emit("message", { type: "session.close" });
      await new Promise((r) => setTimeout(r, 50));

      const endedMsg = messages.find(
        (m) =>
          (m as { type: string }).type === "session.ended" &&
          (m as { reason: string }).reason === "Session closed by user"
      );
      expect(endedMsg).toBeDefined();

      socket.disconnect();
    });
  });
});
