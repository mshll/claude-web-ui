/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket, type ServerMessage } from "./use-websocket";

interface MockManager {
  on: ReturnType<typeof vi.fn>;
}

class MockSocket {
  static instances: MockSocket[] = [];

  connected = false;
  id: string | null = null;
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  io: MockManager = {
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      if (!this.managerEventHandlers.has(event)) {
        this.managerEventHandlers.set(event, new Set());
      }
      this.managerEventHandlers.get(event)!.add(handler);
    }),
  };

  private managerEventHandlers = new Map<string, Set<(data: unknown) => void>>();

  emit = vi.fn();
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  connect = vi.fn();

  constructor() {
    MockSocket.instances.push(this);
  }

  on(event: string, handler: (data: unknown) => void): this {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return this;
  }

  simulateConnect() {
    this.connected = true;
    this.id = "socket-id";
    const handlers = this.eventHandlers.get("connect");
    handlers?.forEach((h) => h(undefined));
  }

  simulateMessage(data: ServerMessage) {
    const handlers = this.eventHandlers.get("message");
    handlers?.forEach((h) => h(data));
  }

  simulateConnectError(error: Error) {
    const handlers = this.eventHandlers.get("connect_error");
    handlers?.forEach((h) => h(error));
  }

  simulateDisconnect(reason: string) {
    this.connected = false;
    const handlers = this.eventHandlers.get("disconnect");
    handlers?.forEach((h) => h(reason));
  }

  simulateReconnectAttempt(attempt: number) {
    const handlers = this.managerEventHandlers.get("reconnect_attempt");
    handlers?.forEach((h) => h(attempt));
  }

  simulateReconnectFailed() {
    const handlers = this.managerEventHandlers.get("reconnect_failed");
    handlers?.forEach((h) => h(undefined));
  }

  simulateReconnect() {
    const handlers = this.managerEventHandlers.get("reconnect");
    handlers?.forEach((h) => h(undefined));
  }
}

const mockIo = vi.fn(() => new MockSocket());

vi.mock("socket.io-client", () => ({
  io: (url: string, options: unknown) => mockIo(url, options),
}));

describe("useWebSocket", () => {
  beforeEach(() => {
    MockSocket.instances = [];
    mockIo.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function getLatestSocket(): MockSocket {
    return MockSocket.instances[MockSocket.instances.length - 1];
  }

  describe("connection", () => {
    it("starts with disconnected status", () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));
      expect(result.current.status).toBe("connecting");
    });

    it("transitions to connected when socket connects", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      expect(result.current.status).toBe("connected");
    });

    it("transitions to disconnected when socket disconnects", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      act(() => {
        getLatestSocket().simulateDisconnect("transport close");
      });

      expect(result.current.status).toBe("disconnected");
    });

    it("sets clientId from connected message", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "connected",
          clientId: "client-123",
        });
      });

      expect(result.current.clientId).toBe("client-123");
    });

    it("clears clientId on disconnect", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "connected",
          clientId: "client-123",
        });
      });

      act(() => {
        getLatestSocket().simulateDisconnect("transport close");
      });

      expect(result.current.clientId).toBeNull();
    });

    it("updates retryCount on reconnect attempt", async () => {
      const onReconnecting = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("http://localhost:12001", {
          maxRetries: 5,
          onReconnecting,
        })
      );

      act(() => {
        getLatestSocket().simulateReconnectAttempt(1);
      });

      expect(result.current.retryCount).toBe(1);
      expect(onReconnecting).toHaveBeenCalledWith(1, 5);
    });

    it("calls onError on reconnect failure", async () => {
      const onError = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onError })
      );

      act(() => {
        getLatestSocket().simulateReconnectFailed();
      });

      expect(onError).toHaveBeenCalledWith("Connection failed after max retries");
    });

    it("resets retry count on successful reconnect", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateReconnectAttempt(3);
      });

      expect(result.current.retryCount).toBe(3);

      act(() => {
        getLatestSocket().simulateReconnect();
      });

      expect(result.current.retryCount).toBe(0);
    });

    it("reconnect() resets retry count and reconnects", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateReconnectAttempt(2);
      });

      expect(result.current.retryCount).toBe(2);
      const instanceCountBefore = MockSocket.instances.length;

      act(() => {
        result.current.reconnect();
      });

      expect(result.current.retryCount).toBe(0);
      expect(MockSocket.instances.length).toBe(instanceCountBefore + 1);
    });

    it("cleans up on unmount", async () => {
      const { unmount } = renderHook(() => useWebSocket("http://localhost:12001"));

      const socket = getLatestSocket();

      unmount();

      expect(socket.disconnect).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("calls onMessage for all messages", async () => {
      const onMessage = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onMessage })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "session.started",
          sessionId: "session-123",
        });
      });

      expect(onMessage).toHaveBeenCalledWith({
        type: "session.started",
        sessionId: "session-123",
      });
    });

    it("calls onSessionStarted and sets activeSessionId", async () => {
      const onSessionStarted = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("http://localhost:12001", { onSessionStarted })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "session.started",
          sessionId: "session-456",
        });
      });

      expect(onSessionStarted).toHaveBeenCalledWith("session-456");
      expect(result.current.activeSessionId).toBe("session-456");
    });

    it("calls onAssistantChunk with content", async () => {
      const onAssistantChunk = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onAssistantChunk })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "assistant.chunk",
          content: "Hello, world!",
        });
      });

      expect(onAssistantChunk).toHaveBeenCalledWith("Hello, world!");
    });

    it("calls onTerminalOutput with data", async () => {
      const onTerminalOutput = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onTerminalOutput })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "terminal.output",
          data: "$ ls\nfile.txt",
        });
      });

      expect(onTerminalOutput).toHaveBeenCalledWith("$ ls\nfile.txt");
    });

    it("calls onSessionEnded and clears activeSessionId", async () => {
      const onSessionEnded = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("http://localhost:12001", { onSessionEnded })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "session.started",
          sessionId: "session-789",
        });
      });

      act(() => {
        getLatestSocket().simulateMessage({
          type: "session.ended",
          reason: "User closed session",
        });
      });

      expect(onSessionEnded).toHaveBeenCalledWith("User closed session");
      expect(result.current.activeSessionId).toBeNull();
    });

    it("calls onError for error messages", async () => {
      const onError = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onError })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "error",
          message: "Something went wrong",
        });
      });

      expect(onError).toHaveBeenCalledWith("Something went wrong");
    });

    it("calls onError for connect errors", async () => {
      const onError = vi.fn();
      renderHook(() =>
        useWebSocket("http://localhost:12001", { onError })
      );

      act(() => {
        getLatestSocket().simulateConnectError(new Error("Connection refused"));
      });

      expect(onError).toHaveBeenCalledWith("Connection refused");
    });

    it("handles session.control messages", async () => {
      const onSessionControl = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("http://localhost:12001", { onSessionControl })
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "session.control",
          hasControl: true,
        });
      });

      expect(onSessionControl).toHaveBeenCalledWith(true);
      expect(result.current.hasControl).toBe(true);
    });

    it("clears hasControl when session ends", async () => {
      const { result } = renderHook(() =>
        useWebSocket("http://localhost:12001")
      );

      act(() => {
        getLatestSocket().simulateConnect();
        getLatestSocket().simulateMessage({
          type: "session.control",
          hasControl: true,
        });
      });

      expect(result.current.hasControl).toBe(true);

      act(() => {
        getLatestSocket().simulateMessage({
          type: "session.ended",
          reason: "Session closed",
        });
      });

      expect(result.current.hasControl).toBe(false);
    });
  });

  describe("sending messages", () => {
    it("send returns false when not connected", () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      expect(result.current.send({ type: "message.send", content: "test" })).toBe(false);
    });

    it("send returns true and sends message when connected", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      const success = result.current.send({ type: "message.send", content: "test" });

      expect(success).toBe(true);
      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "message.send", content: "test" }
      );
    });

    it("startSession sends session.start message", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.startSession("my-session", "/path/to/project");

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        {
          type: "session.start",
          sessionId: "my-session",
          projectPath: "/path/to/project",
          mode: undefined,
          cols: undefined,
          rows: undefined,
          dangerouslySkipPermissions: undefined,
        }
      );
    });

    it("startSession works without sessionId or projectPath", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.startSession();

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        {
          type: "session.start",
          sessionId: undefined,
          projectPath: undefined,
          mode: undefined,
          cols: undefined,
          rows: undefined,
          dangerouslySkipPermissions: undefined,
        }
      );
    });

    it("sendMessage sends message.send with content", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.sendMessage("Hello, Claude!");

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "message.send", content: "Hello, Claude!" }
      );
    });

    it("interrupt sends session.interrupt message", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.interrupt();

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "session.interrupt" }
      );
    });

    it("closeSession sends session.close message", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.closeSession();

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "session.close" }
      );
    });

    it("switchMode sends mode.switch message", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      act(() => {
        getLatestSocket().simulateConnect();
      });

      result.current.switchMode("terminal");

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "mode.switch", mode: "terminal", cols: undefined, rows: undefined, dangerouslySkipPermissions: undefined }
      );
    });

    it("queues messages when disconnected if queueIfDisconnected is true", async () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      const sent = result.current.send({ type: "message.send", content: "queued" }, true);

      expect(sent).toBe(true);
      expect(getLatestSocket().emit).not.toHaveBeenCalledWith(
        "message",
        { type: "message.send", content: "queued" }
      );

      act(() => {
        getLatestSocket().simulateConnect();
      });

      expect(getLatestSocket().emit).toHaveBeenCalledWith(
        "message",
        { type: "message.send", content: "queued" }
      );
    });

    it("does not queue messages by default when disconnected", () => {
      const { result } = renderHook(() => useWebSocket("http://localhost:12001"));

      const sent = result.current.send({ type: "message.send", content: "test" });

      expect(sent).toBe(false);
    });
  });
});
