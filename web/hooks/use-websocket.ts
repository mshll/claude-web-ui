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
  baseDelay?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
}

interface QueuedMessage {
  message: ClientMessage;
  timestamp: number;
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
    rows?: number
  ) => boolean;
  sendMessage: (content: string) => boolean;
  interrupt: () => boolean;
  closeSession: () => boolean;
  switchMode: (mode: "chat" | "terminal", cols?: number, rows?: number) => boolean;
  sendTerminalInput: (data: string) => boolean;
  resizeTerminal: (cols: number, rows: number) => boolean;
  reconnect: () => void;
}

function addJitter(delay: number, jitterFactor: number = 0.3): number {
  const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, delay + jitter);
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
    baseDelay = 1000,
    heartbeatInterval = 25000,
    heartbeatTimeout = 10000,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [clientId, setClientId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hasControl, setHasControl] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPongRef = useRef<number>(Date.now());

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      optionsRef.current.onError?.("Invalid message from server");
      return;
    }

    optionsRef.current.onMessage?.(message);

    switch (message.type) {
      case "connected":
        setClientId(message.clientId ?? null);
        break;

      case "pong":
        lastPongRef.current = Date.now();
        if (heartbeatTimeoutRef.current) {
          clearTimeout(heartbeatTimeoutRef.current);
          heartbeatTimeoutRef.current = null;
        }
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

  const flushMessageQueue = useCallback((ws: WebSocket) => {
    const now = Date.now();
    const maxAge = 30000;

    while (messageQueueRef.current.length > 0) {
      const queued = messageQueueRef.current[0];
      if (now - queued.timestamp > maxAge) {
        messageQueueRef.current.shift();
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(queued.message));
        messageQueueRef.current.shift();
      } else {
        break;
      }
    }
  }, []);

  const startHeartbeat = useCallback((ws: WebSocket) => {
    clearHeartbeat();
    lastPongRef.current = Date.now();

    heartbeatIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));

        heartbeatTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current && Date.now() - lastPongRef.current > heartbeatTimeout) {
            ws.close();
          }
        }, heartbeatTimeout);
      }
    }, heartbeatInterval);
  }, [clearHeartbeat, heartbeatInterval, heartbeatTimeout]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    if (wsRef.current) {
      wsRef.current.close();
    }

    clearHeartbeat();
    setStatus("connecting");

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus("connected");
      retryCountRef.current = 0;
      setRetryCount(0);
      flushMessageQueue(ws);
      startHeartbeat(ws);
    };

    ws.onmessage = handleMessage;

    ws.onerror = (event) => {
      const errorMessage = event instanceof ErrorEvent ? event.message : "WebSocket error";
      optionsRef.current.onError?.(errorMessage);
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;

      clearHeartbeat();
      setStatus("disconnected");
      setClientId(null);
      wsRef.current = null;

      if (!event.wasClean && retryCountRef.current < maxRetries) {
        const baseDelayCurrent = baseDelay * Math.pow(2, retryCountRef.current);
        const delay = addJitter(Math.min(baseDelayCurrent, 30000));
        retryCountRef.current++;
        setRetryCount(retryCountRef.current);

        optionsRef.current.onReconnecting?.(retryCountRef.current, maxRetries);

        retryTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else if (retryCountRef.current >= maxRetries) {
        onError?.("Connection failed after max retries");
      }
    };
  }, [url, handleMessage, maxRetries, baseDelay, onError, clearHeartbeat, flushMessageQueue, startHeartbeat]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      clearHeartbeat();

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      messageQueueRef.current = [];
    };
  }, [connect, clearHeartbeat]);

  const send = useCallback((message: ClientMessage, queueIfDisconnected: boolean = false): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      if (queueIfDisconnected) {
        messageQueueRef.current.push({ message, timestamp: Date.now() });
        return true;
      }
      return false;
    }
    wsRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    setRetryCount(0);
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    connect();
  }, [connect]);

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
