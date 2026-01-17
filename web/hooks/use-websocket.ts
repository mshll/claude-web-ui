import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface ClientMessage {
  type:
    | "session.start"
    | "message.send"
    | "session.interrupt"
    | "mode.switch"
    | "session.close"
    | "terminal.input"
    | "terminal.resize";
  sessionId?: string;
  projectPath?: string;
  content?: string;
  mode?: "chat" | "terminal";
  cols?: number;
  rows?: number;
  dangerouslySkipPermissions?: boolean;
}

export interface ServerMessage {
  type:
    | "connected"
    | "session.started"
    | "assistant.chunk"
    | "terminal.output"
    | "session.ended"
    | "error"
    | "pong"
    | "session.control";
  clientId?: string;
  sessionId?: string;
  content?: unknown;
  data?: string;
  reason?: string;
  message?: string;
  hasControl?: boolean;
}

export interface UseWebSocketOptions {
  onMessage?: (message: ServerMessage) => void;
  onSessionStarted?: (sessionId: string) => void;
  onAssistantChunk?: (content: unknown) => void;
  onTerminalOutput?: (data: string) => void;
  onSessionEnded?: (reason: string) => void;
  onSessionControl?: (hasControl: boolean) => void;
  onError?: (message: string) => void;
  onReconnecting?: (attempt: number, maxRetries: number) => void;
  maxRetries?: number;
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  clientId: string | null;
  activeSessionId: string | null;
  hasControl: boolean;
  retryCount: number;
  send: (message: ClientMessage, queueIfDisconnected?: boolean) => boolean;
  startSession: (
    sessionId?: string,
    projectPath?: string,
    mode?: "chat" | "terminal",
    cols?: number,
    rows?: number,
    dangerouslySkipPermissions?: boolean
  ) => boolean;
  sendMessage: (content: string) => boolean;
  interrupt: () => boolean;
  closeSession: () => boolean;
  switchMode: (mode: "chat" | "terminal", cols?: number, rows?: number, dangerouslySkipPermissions?: boolean) => boolean;
  sendTerminalInput: (data: string) => boolean;
  resizeTerminal: (cols: number, rows: number) => boolean;
  reconnect: () => void;
}

export function useWebSocket(
  url: string,
  options: UseWebSocketOptions = {}
): UseWebSocketReturn {
  const {
    onMessage,
    onSessionStarted,
    onAssistantChunk,
    onTerminalOutput,
    onSessionEnded,
    onSessionControl,
    onError,
    onReconnecting,
    maxRetries = 10,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [clientId, setClientId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hasControl, setHasControl] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const mountedRef = useRef(true);
  const messageQueueRef = useRef<ClientMessage[]>([]);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleMessage = useCallback((message: ServerMessage) => {
    optionsRef.current.onMessage?.(message);

    switch (message.type) {
      case "connected":
        setClientId(message.clientId ?? null);
        break;

      case "session.started":
        setActiveSessionId(message.sessionId ?? null);
        if (message.sessionId) {
          optionsRef.current.onSessionStarted?.(message.sessionId);
        }
        break;

      case "assistant.chunk":
        optionsRef.current.onAssistantChunk?.(message.content);
        break;

      case "terminal.output":
        if (message.data) {
          optionsRef.current.onTerminalOutput?.(message.data);
        }
        break;

      case "session.ended":
        setActiveSessionId(null);
        setHasControl(false);
        optionsRef.current.onSessionEnded?.(message.reason ?? "Session ended");
        break;

      case "session.control":
        setHasControl(message.hasControl ?? false);
        optionsRef.current.onSessionControl?.(message.hasControl ?? false);
        break;

      case "error":
        optionsRef.current.onError?.(message.message ?? "Unknown error");
        break;
    }
  }, []);

  const flushMessageQueue = useCallback((socket: Socket) => {
    while (messageQueueRef.current.length > 0 && socket.connected) {
      const queued = messageQueueRef.current.shift();
      if (queued) {
        socket.emit("message", queued);
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setStatus("connecting");

    const serverUrl = url.replace(/\/ws$/, "").replace(/\/$/, "");

    const socket = io(serverUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: maxRetries,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 20000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      setStatus("connected");
      setRetryCount(0);
      flushMessageQueue(socket);
    });

    socket.on("message", (data: ServerMessage) => {
      if (socketRef.current !== socket) return;
      handleMessage(data);
    });

    socket.on("connect_error", (error) => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      optionsRef.current.onError?.(error.message || "Connection error");
    });

    socket.on("disconnect", (reason) => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      setStatus("disconnected");
      setClientId(null);

      if (reason === "io server disconnect") {
        socket.connect();
      }
    });

    socket.io.on("reconnect_attempt", (attempt) => {
      if (!mountedRef.current) return;
      setRetryCount(attempt);
      optionsRef.current.onReconnecting?.(attempt, maxRetries);
    });

    socket.io.on("reconnect_failed", () => {
      if (!mountedRef.current) return;
      optionsRef.current.onError?.("Connection failed after max retries");
    });

    socket.io.on("reconnect", () => {
      if (!mountedRef.current) return;
      setRetryCount(0);
    });
  }, [url, handleMessage, maxRetries, flushMessageQueue]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      messageQueueRef.current = [];
    };
  }, [connect]);

  const send = useCallback((message: ClientMessage, queueIfDisconnected: boolean = false): boolean => {
    if (!socketRef.current || !socketRef.current.connected) {
      if (queueIfDisconnected) {
        messageQueueRef.current.push(message);
        return true;
      }
      return false;
    }
    socketRef.current.emit("message", message);
    return true;
  }, []);

  const reconnect = useCallback(() => {
    setRetryCount(0);
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    connect();
  }, [connect]);

  const startSession = useCallback(
    (
      sessionId?: string,
      projectPath?: string,
      mode?: "chat" | "terminal",
      cols?: number,
      rows?: number,
      dangerouslySkipPermissions?: boolean
    ): boolean => {
      return send({
        type: "session.start",
        sessionId,
        projectPath,
        mode,
        cols,
        rows,
        dangerouslySkipPermissions,
      });
    },
    [send]
  );

  const sendMessage = useCallback(
    (content: string): boolean => {
      return send({
        type: "message.send",
        content,
      });
    },
    [send]
  );

  const interrupt = useCallback((): boolean => {
    return send({ type: "session.interrupt" });
  }, [send]);

  const closeSession = useCallback((): boolean => {
    return send({ type: "session.close" });
  }, [send]);

  const switchMode = useCallback(
    (mode: "chat" | "terminal", cols?: number, rows?: number, dangerouslySkipPermissions?: boolean): boolean => {
      return send({ type: "mode.switch", mode, cols, rows, dangerouslySkipPermissions });
    },
    [send]
  );

  const sendTerminalInput = useCallback(
    (data: string): boolean => {
      return send({ type: "terminal.input", content: data });
    },
    [send]
  );

  const resizeTerminal = useCallback(
    (cols: number, rows: number): boolean => {
      return send({ type: "terminal.resize", cols, rows });
    },
    [send]
  );

  return {
    status,
    clientId,
    activeSessionId,
    hasControl,
    retryCount,
    send,
    startSession,
    sendMessage,
    interrupt,
    closeSession,
    switchMode,
    sendTerminalInput,
    resizeTerminal,
    reconnect,
  };
}
