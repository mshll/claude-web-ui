import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

export interface ClientInfo {
  id: string;
  ws: WebSocket;
  isAlive: boolean;
}

const clients = new Map<string, ClientInfo>();
let wss: WebSocketServer | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

    ws.on("close", () => {
      clients.delete(clientId);
    });

    ws.on("error", () => {
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
    wss.close();
    wss = null;
  }
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
