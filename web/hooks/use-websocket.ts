import { useEffect, useRef, useCallback, useState } from "react";

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
}

export interface ServerMessage {
  type:
    | "connected"
    | "session.started"
    | "assistant.chunk"
    | "terminal.output"
    | "session.ended"
    | "error";
  clientId?: string;
  sessionId?: string;
  content?: unknown;
  data?: string;
  reason?: string;
  message?: string;
}

export interface UseWebSocketOptions {
  onMessage?: (message: ServerMessage) => void;
  onSessionStarted?: (sessionId: string) => void;
  onAssistantChunk?: (content: unknown) => void;
  onTerminalOutput?: (data: string) => void;
  onSessionEnded?: (reason: string) => void;
  onError?: (message: string) => void;
  maxRetries?: number;
  baseDelay?: number;
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  clientId: string | null;
  activeSessionId: string | null;
  send: (message: ClientMessage) => boolean;
  startSession: (
    sessionId?: string,
    projectPath?: string,
    mode?: "chat" | "terminal",
    cols?: number,
    rows?: number
  ) => boolean;
  sendMessage: (content: string) => boolean;
  interrupt: () => boolean;
  closeSession: () => boolean;
  switchMode: (mode: "chat" | "terminal", cols?: number, rows?: number) => boolean;
  sendTerminalInput: (data: string) => boolean;
  resizeTerminal: (cols: number, rows: number) => boolean;
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
    onError,
    maxRetries = 10,
    baseDelay = 1000,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [clientId, setClientId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleMessage = useCallback((event: MessageEvent) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }

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
        optionsRef.current.onSessionEnded?.(message.reason ?? "Session ended");
        break;

      case "error":
        optionsRef.current.onError?.(message.message ?? "Unknown error");
        break;
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    if (wsRef.current) {
      wsRef.current.close();
    }

    setStatus("connecting");

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus("connected");
      retryCountRef.current = 0;
    };

    ws.onmessage = handleMessage;

    ws.onerror = () => {
      // Error handling done in onclose
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;

      setStatus("disconnected");
      setClientId(null);
      wsRef.current = null;

      if (retryCountRef.current < maxRetries) {
        const delay = Math.min(
          baseDelay * Math.pow(2, retryCountRef.current),
          30000
        );
        retryCountRef.current++;

        retryTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else {
        onError?.("Connection failed after max retries");
      }
    };
  }, [url, handleMessage, maxRetries, baseDelay, onError]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((message: ClientMessage): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    wsRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const startSession = useCallback(
    (
      sessionId?: string,
      projectPath?: string,
      mode?: "chat" | "terminal",
      cols?: number,
      rows?: number
    ): boolean => {
      return send({
        type: "session.start",
        sessionId,
        projectPath,
        mode,
        cols,
        rows,
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
    (mode: "chat" | "terminal", cols?: number, rows?: number): boolean => {
      return send({ type: "mode.switch", mode, cols, rows });
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
    send,
    startSession,
    sendMessage,
    interrupt,
    closeSession,
    switchMode,
    sendTerminalInput,
    resizeTerminal,
  };
}
