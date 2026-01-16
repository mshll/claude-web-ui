import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { WebSocket } from "ws";
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
    sendToProcess: vi.fn((processId: string, message: string) => {
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

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
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
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledTimes(1);

      const startedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.started"
      );
      expect(startedMsg).toBeDefined();

      ws.close();
    });

    it("should pass sessionId to spawnClaudeProcess for resume", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      ws.send(JSON.stringify({ type: "session.start", sessionId: "test-session-123" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledWith({
        sessionId: "test-session-123",
        projectPath: undefined,
      });

      ws.close();
    });

    it("should pass projectPath to spawnClaudeProcess", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      ws.send(JSON.stringify({
        type: "session.start",
        projectPath: "/path/to/project",
      }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.spawnClaudeProcess).toHaveBeenCalledWith({
        sessionId: undefined,
        projectPath: "/path/to/project",
      });

      ws.close();
    });

    it("should track client-process association", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      expect(processId).toBeDefined();
      expect(processId).toMatch(/^mock-proc-/);

      expect(getProcessClientId(processId!)).toBe(clientId);

      ws.close();
    });

    it("should kill existing process when starting new session", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const firstProcessId = getClientProcessId(clientId);

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.killProcess).toHaveBeenCalledWith(firstProcessId);

      const secondProcessId = getClientProcessId(clientId);
      expect(secondProcessId).not.toBe(firstProcessId);

      ws.close();
    });
  });

  describe("message.send", () => {
    it("should send message to process stdin", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ type: "message.send", content: "Hello Claude" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.sendToProcess).toHaveBeenCalledWith(
        expect.stringMatching(/^mock-proc-/),
        JSON.stringify({ type: "user", content: "Hello Claude" })
      );

      ws.close();
    });

    it("should return error when no session is active", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "message.send", content: "Hello" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "No active session. Start a session first.",
      });

      ws.close();
    });

    it("should return error when content is missing", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "message.send" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "Message content is required",
      });

      ws.close();
    });
  });

  describe("session.interrupt", () => {
    it("should send SIGINT to the process", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);

      ws.send(JSON.stringify({ type: "session.interrupt" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.interruptProcess).toHaveBeenCalledWith(processId);

      ws.close();
    });

    it("should return error when no session is active", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);

      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "session.interrupt" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorMsg = messages.find(
        (m) => (m as { type: string }).type === "error"
      );
      expect(errorMsg).toMatchObject({
        type: "error",
        message: "No active session to interrupt",
      });

      ws.close();
    });
  });

  describe("session.close", () => {
    it("should kill the process and send session.ended", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "session.close" }));
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

      ws.close();
    });
  });

  describe("process output forwarding", () => {
    it("should forward stdout as assistant.chunk", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(ws);

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

      ws.close();
    });

    it("should forward process exit as session.ended", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(ws);

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

      ws.close();
    });

    it("should forward process error as error message", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const processId = getClientProcessId(clientId);
      const messages = collectMessages(ws);

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

      ws.close();
    });
  });

  describe("full message round-trip", () => {
    it("should complete a full send-receive cycle", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForMessage(ws);
      const clientId = getConnectedClients()[0];

      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "session.start" }));
      await new Promise((r) => setTimeout(r, 50));

      const startedMsg = messages.find(
        (m) => (m as { type: string }).type === "session.started"
      );
      expect(startedMsg).toBeDefined();

      const processId = getClientProcessId(clientId);

      ws.send(JSON.stringify({ type: "message.send", content: "What is 2+2?" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mockProcessManager.sendToProcess).toHaveBeenCalledWith(
        processId,
        JSON.stringify({ type: "user", content: "What is 2+2?" })
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

      ws.send(JSON.stringify({ type: "session.close" }));
      await new Promise((r) => setTimeout(r, 50));

      const endedMsg = messages.find(
        (m) =>
          (m as { type: string }).type === "session.ended" &&
          (m as { reason: string }).reason === "Session closed by user"
      );
      expect(endedMsg).toBeDefined();

      ws.close();
    });
  });
});
