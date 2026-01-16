import {
  type ClientMessage,
  type ServerMessage,
  sendToClient,
  sendToSession,
  associateClientWithSession,
  dissociateClientFromSession,
} from "./websocket";
import {
  spawnClaudeProcess,
  sendToProcess,
  interruptProcess,
  killProcess,
  onProcessOutput,
  offProcessOutput,
  type ProcessInfo,
} from "./process-manager";
import {
  spawnClaudePty,
  writeToPty,
  resizePty,
  killPty,
  onPtyOutput,
  offPtyOutput,
  type PtyInfo,
} from "./pty-manager";

type SessionMode = "chat" | "terminal";
type SessionStatus = "active" | "ended";

interface ClientSession {
  mode: SessionMode;
  processId?: string;
  ptyId?: string;
  sessionId?: string;
  status: SessionStatus;
  endReason?: string;
}

const clientSessions = new Map<string, ClientSession>();
const processClients = new Map<string, string>();
const ptyClients = new Map<string, string>();

function handleProcessOutput(
  processId: string,
  output: {
    type: "stdout" | "stderr" | "exit" | "error";
    data?: string;
    code?: number | null;
    signal?: string | null;
    error?: string;
  }
): void {
  const clientId = processClients.get(processId);
  if (!clientId) return;

  const clientSession = clientSessions.get(clientId);
  const sessionId = clientSession?.sessionId;

  if (output.type === "stdout" || output.type === "stderr") {
    const message: ServerMessage = {
      type: "assistant.chunk",
      content: output.data,
    };

    if (sessionId) {
      sendToSession(sessionId, message);
    } else {
      sendToClient(clientId, message);
    }
  } else if (output.type === "exit") {
    const reason = output.signal
      ? `Signal: ${output.signal}`
      : `Exit code: ${output.code}`;
    const message: ServerMessage = {
      type: "session.ended",
      reason,
    };

    if (sessionId) {
      sendToSession(sessionId, message);
    } else {
      sendToClient(clientId, message);
    }

    markSessionEnded(clientId, reason);
  } else if (output.type === "error") {
    const reason = output.error || "Process error";
    const errorMessage: ServerMessage = {
      type: "error",
      message: reason,
    };
    const endedMessage: ServerMessage = {
      type: "session.ended",
      reason,
    };

    sendToClient(clientId, errorMessage);
    sendToClient(clientId, endedMessage);
    markSessionEnded(clientId, reason);
  }
}

function handlePtyOutput(
  ptyId: string,
  output: {
    type: "data" | "exit";
    data?: string;
    exitCode?: number;
  }
): void {
  const clientId = ptyClients.get(ptyId);
  if (!clientId) return;

  const clientSession = clientSessions.get(clientId);
  const sessionId = clientSession?.sessionId;

  if (output.type === "data") {
    const message: ServerMessage = {
      type: "terminal.output",
      data: output.data,
    };

    if (sessionId) {
      sendToSession(sessionId, message);
    } else {
      sendToClient(clientId, message);
    }
  } else if (output.type === "exit") {
    const reason = `Exit code: ${output.exitCode}`;
    const message: ServerMessage = {
      type: "session.ended",
      reason,
    };

    if (sessionId) {
      sendToSession(sessionId, message);
    } else {
      sendToClient(clientId, message);
    }

    markSessionEnded(clientId, reason);
  }
}

function markSessionEnded(clientId: string, reason: string): void {
  const clientSession = clientSessions.get(clientId);
  if (clientSession) {
    clientSession.status = "ended";
    clientSession.endReason = reason;
    if (clientSession.processId) {
      processClients.delete(clientSession.processId);
      clientSession.processId = undefined;
    }
    if (clientSession.ptyId) {
      ptyClients.delete(clientSession.ptyId);
      clientSession.ptyId = undefined;
    }
  }
}

function cleanupClientSession(clientId: string): void {
  const clientSession = clientSessions.get(clientId);
  if (clientSession) {
    if (clientSession.processId) {
      processClients.delete(clientSession.processId);
    }
    if (clientSession.ptyId) {
      ptyClients.delete(clientSession.ptyId);
    }
    clientSessions.delete(clientId);
  }
}

let processOutputHandlerRegistered = false;
let ptyOutputHandlerRegistered = false;

function ensureOutputHandlers(): void {
  if (!processOutputHandlerRegistered) {
    onProcessOutput(handleProcessOutput);
    processOutputHandlerRegistered = true;
  }
  if (!ptyOutputHandlerRegistered) {
    onPtyOutput(handlePtyOutput);
    ptyOutputHandlerRegistered = true;
  }
}

export function handleSessionMessage(
  clientId: string,
  message: ClientMessage
): void {
  ensureOutputHandlers();

  switch (message.type) {
    case "session.start":
      handleSessionStart(clientId, message);
      break;
    case "message.send":
      handleMessageSend(clientId, message);
      break;
    case "session.interrupt":
      handleSessionInterrupt(clientId);
      break;
    case "session.close":
      handleSessionClose(clientId);
      break;
    case "mode.switch":
      handleModeSwitch(clientId, message);
      break;
    case "terminal.input":
      handleTerminalInput(clientId, message);
      break;
    case "terminal.resize":
      handleTerminalResize(clientId, message);
      break;
  }
}

function handleSessionStart(clientId: string, message: ClientMessage): void {
  const existingSession = clientSessions.get(clientId);
  if (existingSession) {
    if (existingSession.processId) {
      killProcess(existingSession.processId);
    }
    if (existingSession.ptyId) {
      killPty(existingSession.ptyId);
    }
    cleanupClientSession(clientId);
  }

  const mode: SessionMode = message.mode || "chat";

  if (mode === "terminal") {
    let ptyInfo: PtyInfo;
    try {
      ptyInfo = spawnClaudePty({
        sessionId: message.sessionId,
        projectPath: message.projectPath,
        cols: message.cols,
        rows: message.rows,
        dangerouslySkipPermissions: message.dangerouslySkipPermissions,
      });
    } catch (err) {
      sendToClient(clientId, {
        type: "error",
        message: err instanceof Error ? err.message : "Failed to start session",
      });
      return;
    }

    clientSessions.set(clientId, {
      mode: "terminal",
      ptyId: ptyInfo.id,
      sessionId: message.sessionId,
      status: "active",
    });
    ptyClients.set(ptyInfo.id, clientId);

    if (message.sessionId) {
      associateClientWithSession(clientId, message.sessionId);
    }

    sendToClient(clientId, {
      type: "session.started",
      sessionId: message.sessionId || ptyInfo.id,
      mode: "terminal",
    });
  } else {
    let processInfo: ProcessInfo;
    try {
      processInfo = spawnClaudeProcess({
        sessionId: message.sessionId,
        projectPath: message.projectPath,
        dangerouslySkipPermissions: message.dangerouslySkipPermissions,
      });
    } catch (err) {
      sendToClient(clientId, {
        type: "error",
        message: err instanceof Error ? err.message : "Failed to start session",
      });
      return;
    }

    clientSessions.set(clientId, {
      mode: "chat",
      processId: processInfo.id,
      sessionId: message.sessionId,
      status: "active",
    });
    processClients.set(processInfo.id, clientId);

    if (message.sessionId) {
      associateClientWithSession(clientId, message.sessionId);
    }

    sendToClient(clientId, {
      type: "session.started",
      sessionId: message.sessionId || processInfo.id,
      mode: "chat",
    });
  }
}

function handleMessageSend(clientId: string, message: ClientMessage): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession) {
    sendToClient(clientId, {
      type: "error",
      message: "No active session. Start a session first.",
    });
    return;
  }

  if (clientSession.status === "ended") {
    sendToClient(clientId, {
      type: "error",
      message: clientSession.endReason
        ? `Session ended: ${clientSession.endReason}`
        : "Session has ended",
    });
    return;
  }

  if (!message.content) {
    sendToClient(clientId, {
      type: "error",
      message: "Message content is required",
    });
    return;
  }

  if (clientSession.mode === "terminal" && clientSession.ptyId) {
    const success = writeToPty(clientSession.ptyId, message.content);
    if (!success) {
      sendToClient(clientId, {
        type: "error",
        message: "Failed to send message to terminal",
      });
    }
  } else if (clientSession.processId) {
    const jsonMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: message.content,
      },
    });

    const success = sendToProcess(clientSession.processId, jsonMessage);
    if (!success) {
      sendToClient(clientId, {
        type: "error",
        message: "Failed to send message to process",
      });
    }
  }
}

function handleSessionInterrupt(clientId: string): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession) {
    sendToClient(clientId, {
      type: "error",
      message: "No active session to interrupt",
    });
    return;
  }

  if (clientSession.mode === "terminal" && clientSession.ptyId) {
    writeToPty(clientSession.ptyId, "\x03");
  } else if (clientSession.processId) {
    interruptProcess(clientSession.processId);
  }
}

function handleSessionClose(clientId: string): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession) {
    return;
  }

  if (clientSession.processId) {
    killProcess(clientSession.processId);
  }
  if (clientSession.ptyId) {
    killPty(clientSession.ptyId);
  }

  if (clientSession.sessionId) {
    dissociateClientFromSession(clientId);
  }

  cleanupClientSession(clientId);

  sendToClient(clientId, {
    type: "session.ended",
    reason: "Session closed by user",
  });
}

function handleModeSwitch(clientId: string, message: ClientMessage): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession) {
    sendToClient(clientId, {
      type: "error",
      message: "No active session. Start a session first.",
    });
    return;
  }

  const newMode = message.mode;
  if (!newMode || newMode === clientSession.mode) {
    return;
  }

  const sessionId = clientSession.sessionId;
  const projectPath = clientSession.processId
    ? undefined
    : clientSession.ptyId
      ? undefined
      : undefined;

  if (clientSession.processId) {
    killProcess(clientSession.processId);
    processClients.delete(clientSession.processId);
  }
  if (clientSession.ptyId) {
    killPty(clientSession.ptyId);
    ptyClients.delete(clientSession.ptyId);
  }

  clientSessions.delete(clientId);

  handleSessionStart(clientId, {
    type: "session.start",
    sessionId,
    projectPath,
    mode: newMode,
    cols: message.cols,
    rows: message.rows,
  });
}

function handleTerminalInput(clientId: string, message: ClientMessage): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession || clientSession.mode !== "terminal") {
    sendToClient(clientId, {
      type: "error",
      message: "No active terminal session",
    });
    return;
  }

  if (!message.content) {
    return;
  }

  if (clientSession.ptyId) {
    writeToPty(clientSession.ptyId, message.content);
  }
}

function handleTerminalResize(clientId: string, message: ClientMessage): void {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession || clientSession.mode !== "terminal") {
    return;
  }

  if (clientSession.ptyId && message.cols && message.rows) {
    resizePty(clientSession.ptyId, message.cols, message.rows);
  }
}

export function cleanupSessionHandler(): void {
  if (processOutputHandlerRegistered) {
    offProcessOutput(handleProcessOutput);
    processOutputHandlerRegistered = false;
  }
  if (ptyOutputHandlerRegistered) {
    offPtyOutput(handlePtyOutput);
    ptyOutputHandlerRegistered = false;
  }
  clientSessions.clear();
  processClients.clear();
  ptyClients.clear();
}

export function getClientProcessId(clientId: string): string | undefined {
  return clientSessions.get(clientId)?.processId;
}

export function getClientPtyId(clientId: string): string | undefined {
  return clientSessions.get(clientId)?.ptyId;
}

export function getProcessClientId(processId: string): string | undefined {
  return processClients.get(processId);
}

export function getPtyClientId(ptyId: string): string | undefined {
  return ptyClients.get(ptyId);
}

export function getClientMode(clientId: string): SessionMode | undefined {
  return clientSessions.get(clientId)?.mode;
}
