/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWebSocket, type ServerMessage } from "./use-websocket";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { wasClean: boolean; code: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  private closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ wasClean: true, code: 1000 });
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError() {
    this.onerror?.(new Event("error"));
  }

  simulateClose(wasClean = true) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ wasClean, code: wasClean ? 1000 : 1006 });
  }

  simulateUncleanClose() {
    this.simulateClose(false);
  }
}

describe("useWebSocket", () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  function getLatestWebSocket(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  describe("connection", () => {
    it("starts with disconnected status", () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));
      expect(result.current.status).toBe("connecting");
    });

    it("transitions to connected when WebSocket opens", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      expect(result.current.status).toBe("connected");
    });

    it("transitions to disconnected when WebSocket closes", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      act(() => {
        getLatestWebSocket().simulateClose();
      });

      expect(result.current.status).toBe("disconnected");
    });

    it("sets clientId from connected message", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "connected",
          clientId: "client-123",
        });
      });

      expect(result.current.clientId).toBe("client-123");
    });

    it("clears clientId on disconnect", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "connected",
          clientId: "client-123",
        });
      });

      act(() => {
        getLatestWebSocket().simulateClose();
      });

      expect(result.current.clientId).toBeNull();
    });

    it("attempts reconnection with exponential backoff on unclean close", async () => {
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { baseDelay: 1000 })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      expect(MockWebSocket.instances).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(MockWebSocket.instances).toHaveLength(2);

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(MockWebSocket.instances).toHaveLength(3);
    });

    it("does not reconnect on clean close", async () => {
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { baseDelay: 100 })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      act(() => {
        getLatestWebSocket().simulateClose(true);
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("stops reconnecting after max retries", async () => {
      const onError = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", {
          maxRetries: 2,
          baseDelay: 100,
          onError,
        })
      );

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(400);
      });

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      expect(onError).toHaveBeenCalledWith("Connection failed after max retries");
    });

    it("resets retry count on successful connection", async () => {
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { baseDelay: 100, maxRetries: 3 })
      );

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(MockWebSocket.instances).toHaveLength(3);
    });

    it("calls onReconnecting callback with retry count", async () => {
      const onReconnecting = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", {
          baseDelay: 100,
          maxRetries: 5,
          onReconnecting,
        })
      );

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(onReconnecting).toHaveBeenCalledWith(1, 5);

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(onReconnecting).toHaveBeenCalledWith(2, 5);
    });

    it("exposes retryCount state", async () => {
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { baseDelay: 100 })
      );

      expect(result.current.retryCount).toBe(0);

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.retryCount).toBe(1);
    });

    it("reconnect() resets retry count and reconnects", async () => {
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { baseDelay: 100, maxRetries: 2 })
      );

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      act(() => {
        getLatestWebSocket().simulateUncleanClose();
      });

      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(result.current.retryCount).toBe(2);
      const instanceCountBefore = MockWebSocket.instances.length;

      act(() => {
        result.current.reconnect();
      });

      expect(result.current.retryCount).toBe(0);
      expect(MockWebSocket.instances.length).toBe(instanceCountBefore + 1);
    });

    it("cleans up on unmount", async () => {
      const { unmount } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      const ws = getLatestWebSocket();
      const closeSpy = vi.spyOn(ws, "close");

      unmount();

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("calls onMessage for all messages", async () => {
      const onMessage = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onMessage })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
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
        useWebSocket("ws://localhost:12001/ws", { onSessionStarted })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
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
        useWebSocket("ws://localhost:12001/ws", { onAssistantChunk })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "assistant.chunk",
          content: "Hello, world!",
        });
      });

      expect(onAssistantChunk).toHaveBeenCalledWith("Hello, world!");
    });

    it("calls onTerminalOutput with data", async () => {
      const onTerminalOutput = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onTerminalOutput })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "terminal.output",
          data: "$ ls\nfile.txt",
        });
      });

      expect(onTerminalOutput).toHaveBeenCalledWith("$ ls\nfile.txt");
    });

    it("calls onSessionEnded and clears activeSessionId", async () => {
      const onSessionEnded = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onSessionEnded })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "session.started",
          sessionId: "session-789",
        });
      });

      act(() => {
        getLatestWebSocket().simulateMessage({
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
        useWebSocket("ws://localhost:12001/ws", { onError })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "error",
          message: "Something went wrong",
        });
      });

      expect(onError).toHaveBeenCalledWith("Something went wrong");
    });

    it("calls onError for invalid JSON messages", async () => {
      const onError = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onError })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().onmessage?.({ data: "not json" });
      });

      expect(onError).toHaveBeenCalledWith("Invalid message from server");
    });

    it("handles pong messages and updates lastPong", async () => {
      const onMessage = vi.fn();
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onMessage })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({ type: "pong" });
      });

      expect(onMessage).toHaveBeenCalledWith({ type: "pong" });
    });

    it("handles session.control messages", async () => {
      const onSessionControl = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { onSessionControl })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "session.control",
          hasControl: true,
        });
      });

      expect(onSessionControl).toHaveBeenCalledWith(true);
      expect(result.current.hasControl).toBe(true);
    });

    it("clears hasControl when session ends", async () => {
      const { result } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws")
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
        getLatestWebSocket().simulateMessage({
          type: "session.control",
          hasControl: true,
        });
      });

      expect(result.current.hasControl).toBe(true);

      act(() => {
        getLatestWebSocket().simulateMessage({
          type: "session.ended",
          reason: "Session closed",
        });
      });

      expect(result.current.hasControl).toBe(false);
    });
  });

  describe("sending messages", () => {
    it("send returns false when not connected", () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      expect(result.current.send({ type: "message.send", content: "test" })).toBe(false);
    });

    it("send returns true and sends message when connected", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      const success = result.current.send({ type: "message.send", content: "test" });

      expect(success).toBe(true);
      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "message.send", content: "test" })
      );
    });

    it("startSession sends session.start message", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.startSession("my-session", "/path/to/project");

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "session.start",
          sessionId: "my-session",
          projectPath: "/path/to/project",
        })
      );
    });

    it("startSession works without sessionId or projectPath", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.startSession();

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "session.start",
          sessionId: undefined,
          projectPath: undefined,
        })
      );
    });

    it("sendMessage sends message.send with content", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.sendMessage("Hello, Claude!");

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "message.send", content: "Hello, Claude!" })
      );
    });

    it("interrupt sends session.interrupt message", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.interrupt();

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session.interrupt" })
      );
    });

    it("closeSession sends session.close message", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.closeSession();

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session.close" })
      );
    });

    it("switchMode sends mode.switch message", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      result.current.switchMode("terminal");

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "mode.switch", mode: "terminal" })
      );
    });

    it("queues messages when disconnected if queueIfDisconnected is true", async () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      const sent = result.current.send({ type: "message.send", content: "queued" }, true);

      expect(sent).toBe(true);
      expect(getLatestWebSocket().send).not.toHaveBeenCalled();

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "message.send", content: "queued" })
      );
    });

    it("does not queue messages by default when disconnected", () => {
      const { result } = renderHook(() => useWebSocket("ws://localhost:12001/ws"));

      const sent = result.current.send({ type: "message.send", content: "test" });

      expect(sent).toBe(false);
    });
  });

  describe("heartbeat", () => {
    it("sends ping messages at heartbeat interval", async () => {
      renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { heartbeatInterval: 1000 })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      expect(getLatestWebSocket().send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "ping" })
      );

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(getLatestWebSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ping" })
      );
    });

    it("clears heartbeat interval on unmount", async () => {
      const { unmount } = renderHook(() =>
        useWebSocket("ws://localhost:12001/ws", { heartbeatInterval: 1000 })
      );

      act(() => {
        getLatestWebSocket().simulateOpen();
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(getLatestWebSocket().send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "ping" })
      );
    });
  });
});
