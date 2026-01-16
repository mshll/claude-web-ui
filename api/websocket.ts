import { WebSocketServer, WebSocket } from "ws";
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
    | "session.close";
  sessionId?: string;
  projectPath?: string;
  content?: string;
  mode?: "chat" | "terminal";
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
  [key: string]: unknown;
}

export interface ClientInfo {
  id: string;
  ws: WebSocket;
  isAlive: boolean;
  sessionId?: string;
}

export type MessageHandler = (
  clientId: string,
  message: ClientMessage
) => void | Promise<void>;

const clients = new Map<string, ClientInfo>();
const sessionClients = new Map<string, Set<string>>();
let wss: WebSocketServer | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let messageHandler: MessageHandler | null = null;

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handleClientMessage(clientId: string, data: string): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(data) as ClientMessage;
  } catch {
    sendToClient(clientId, {
      type: "error",
      message: "Invalid JSON message",
    });
    return;
  }

  if (!message.type) {
    sendToClient(clientId, {
      type: "error",
      message: "Message must have a type",
    });
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
    const sessionSet = sessionClients.get(client.sessionId);
    if (sessionSet) {
      sessionSet.delete(clientId);
      if (sessionSet.size === 0) {
        sessionClients.delete(client.sessionId);
      }
    }
  }
}

export function initWebSocket(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    const clientId = generateClientId();
    const clientInfo: ClientInfo = { id: clientId, ws, isAlive: true };
    clients.set(clientId, clientInfo);

    ws.on("pong", () => {
      clientInfo.isAlive = true;
    });

    ws.on("message", (data) => {
      handleClientMessage(clientId, data.toString());
    });

    ws.on("close", () => {
      removeClientFromSession(clientId);
      clients.delete(clientId);
    });

    ws.on("error", () => {
      removeClientFromSession(clientId);
      clients.delete(clientId);
    });

    sendToClient(clientId, { type: "connected", clientId });
  });

  heartbeatInterval = setInterval(() => {
    for (const [clientId, client] of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        clients.delete(clientId);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 30000);

  return wss;
}

export function stopWebSocket(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (wss) {
    for (const client of clients.values()) {
      client.ws.terminate();
    }
    clients.clear();
    sessionClients.clear();
    wss.close();
    wss = null;
  }
  messageHandler = null;
}

export function sendToClient(clientId: string, message: WebSocketMessage): boolean {
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  client.ws.send(JSON.stringify(message));
  return true;
}

export function broadcast(message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

export function getConnectedClients(): string[] {
  return Array.from(clients.keys());
}

export function getClientCount(): number {
  return clients.size;
}

export function getWebSocketServer(): WebSocketServer | null {
  return wss;
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

  let sessionSet = sessionClients.get(sessionId);
  if (!sessionSet) {
    sessionSet = new Set();
    sessionClients.set(sessionId, sessionSet);
  }
  sessionSet.add(clientId);

  return true;
}

export function dissociateClientFromSession(clientId: string): boolean {
  const client = clients.get(clientId);
  if (!client || !client.sessionId) {
    return false;
  }

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
