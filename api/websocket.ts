import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

export interface ClientMessage {
  type:
    | "session.start"
    | "message.send"
    | "session.interrupt"
    | "mode.switch"
    | "session.close"
    | "terminal.input"
    | "terminal.resize"
    | "ping";
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
  [key: string]: unknown;
}

export interface ClientInfo {
  id: string;
  socket: Socket;
  sessionId?: string;
}

export type MessageHandler = (
  clientId: string,
  message: ClientMessage
) => void | Promise<void>;

const clients = new Map<string, ClientInfo>();
const sessionClients = new Map<string, Set<string>>();
const sessionControllers = new Map<string, string>();
let io: SocketIOServer | null = null;
let messageHandler: MessageHandler | null = null;

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handleClientMessage(clientId: string, message: ClientMessage): void {
  if (!message.type) {
    sendToClient(clientId, {
      type: "error",
      message: "Message must have a type",
    });
    return;
  }

  if (message.type === "ping") {
    sendToClient(clientId, { type: "pong" });
    return;
  }

  if (messageHandler) {
    try {
      Promise.resolve(messageHandler(clientId, message)).catch((err) => {
        sendToClient(clientId, {
          type: "error",
          message: err instanceof Error ? err.message : "Handler error",
        });
      });
    } catch (err) {
      sendToClient(clientId, {
        type: "error",
        message: err instanceof Error ? err.message : "Handler error",
      });
    }
  }
}

function removeClientFromSession(clientId: string): void {
  const client = clients.get(clientId);
  if (client?.sessionId) {
    const sessionId = client.sessionId;
    const sessionSet = sessionClients.get(sessionId);
    if (sessionSet) {
      sessionSet.delete(clientId);
      if (sessionSet.size === 0) {
        sessionClients.delete(sessionId);
        sessionControllers.delete(sessionId);
      } else if (sessionControllers.get(sessionId) === clientId) {
        const nextController = sessionSet.values().next().value;
        if (nextController) {
          sessionControllers.set(sessionId, nextController);
          sendToClient(nextController, {
            type: "session.control",
            hasControl: true,
          });
        }
      }
    }
  }
}

export function initWebSocket(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    path: "/socket.io",
    cors: {
      origin: ["http://localhost:12000", "http://localhost:12001"],
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.on("connection", (socket: Socket) => {
    const clientId = generateClientId();
    const clientInfo: ClientInfo = { id: clientId, socket };
    clients.set(clientId, clientInfo);

    socket.emit("message", { type: "connected", clientId });

    socket.on("message", (data: ClientMessage) => {
      handleClientMessage(clientId, data);
    });

    socket.on("disconnect", () => {
      removeClientFromSession(clientId);
      clients.delete(clientId);
    });

    socket.on("error", () => {
      removeClientFromSession(clientId);
      clients.delete(clientId);
    });
  });

  return io;
}

export function stopWebSocket(): void {
  if (io) {
    for (const client of clients.values()) {
      client.socket.disconnect(true);
    }
    clients.clear();
    sessionClients.clear();
    sessionControllers.clear();
    io.close();
    io = null;
  }
  messageHandler = null;
}

export function sendToClient(clientId: string, message: WebSocketMessage): boolean {
  const client = clients.get(clientId);
  if (!client || !client.socket.connected) {
    return false;
  }
  client.socket.emit("message", message);
  return true;
}

export function broadcast(message: WebSocketMessage): void {
  if (io) {
    io.emit("message", message);
  }
}

export function getConnectedClients(): string[] {
  return Array.from(clients.keys());
}

export function getClientCount(): number {
  return clients.size;
}

export function getSocketIOServer(): SocketIOServer | null {
  return io;
}

export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler;
}

export function associateClientWithSession(
  clientId: string,
  sessionId: string
): boolean {
  const client = clients.get(clientId);
  if (!client) {
    return false;
  }

  removeClientFromSession(clientId);

  client.sessionId = sessionId;
  client.socket.join(`session-${sessionId}`);

  let sessionSet = sessionClients.get(sessionId);
  if (!sessionSet) {
    sessionSet = new Set();
    sessionClients.set(sessionId, sessionSet);
  }
  sessionSet.add(clientId);

  if (!sessionControllers.has(sessionId)) {
    sessionControllers.set(sessionId, clientId);
    sendToClient(clientId, {
      type: "session.control",
      hasControl: true,
    });
  } else {
    sendToClient(clientId, {
      type: "session.control",
      hasControl: false,
    });
  }

  return true;
}

export function dissociateClientFromSession(clientId: string): boolean {
  const client = clients.get(clientId);
  if (!client || !client.sessionId) {
    return false;
  }

  const sessionId = client.sessionId;
  client.socket.leave(`session-${sessionId}`);
  removeClientFromSession(clientId);
  client.sessionId = undefined;
  return true;
}

export function getClientsBySession(sessionId: string): string[] {
  const sessionSet = sessionClients.get(sessionId);
  return sessionSet ? Array.from(sessionSet) : [];
}

export function getClientSession(clientId: string): string | undefined {
  return clients.get(clientId)?.sessionId;
}

export function sendToSession(
  sessionId: string,
  message: WebSocketMessage
): number {
  const clientIds = getClientsBySession(sessionId);
  let sent = 0;
  for (const clientId of clientIds) {
    if (sendToClient(clientId, message)) {
      sent++;
    }
  }
  return sent;
}

export function getActiveSessions(): string[] {
  return Array.from(sessionClients.keys());
}

export function hasSessionControl(clientId: string, sessionId: string): boolean {
  return sessionControllers.get(sessionId) === clientId;
}

export function getSessionController(sessionId: string): string | undefined {
  return sessionControllers.get(sessionId);
}

export function requestSessionControl(clientId: string, sessionId: string): boolean {
  const client = clients.get(clientId);
  if (!client || client.sessionId !== sessionId) {
    return false;
  }

  const currentController = sessionControllers.get(sessionId);
  if (currentController === clientId) {
    return true;
  }

  if (currentController) {
    sendToClient(currentController, {
      type: "session.control",
      hasControl: false,
    });
  }

  sessionControllers.set(sessionId, clientId);
  sendToClient(clientId, {
    type: "session.control",
    hasControl: true,
  });

  return true;
}
