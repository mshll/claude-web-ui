import {
  type ClientMessage,
  type ServerMessage,
  sendToClient,
  sendToSession,
  associateClientWithSession,
  dissociateClientFromSession,
  getClientSession,
} from "./websocket";
import {
  spawnClaudeProcess,
  sendToProcess,
  interruptProcess,
  killProcess,
  onProcessOutput,
  offProcessOutput,
  type ProcessInfo,
  type OutputHandler,
} from "./process-manager";

interface ClientProcess {
  processId: string;
  sessionId?: string;
}

const clientProcesses = new Map<string, ClientProcess>();
const processClients = new Map<string, string>();

function handleProcessOutput(processId: string, output: {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  code?: number | null;
  signal?: string | null;
  error?: string;
}): void {
  const clientId = processClients.get(processId);
  if (!clientId) return;

  const clientProcess = clientProcesses.get(clientId);
  const sessionId = clientProcess?.sessionId;

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
    const message: ServerMessage = {
      type: "session.ended",
      reason: output.signal ? `Signal: ${output.signal}` : `Exit code: ${output.code}`,
    };

    if (sessionId) {
      sendToSession(sessionId, message);
    } else {
      sendToClient(clientId, message);
    }

    cleanupClientProcess(clientId);
  } else if (output.type === "error") {
    const message: ServerMessage = {
      type: "error",
      message: output.error || "Process error",
    };

    sendToClient(clientId, message);
    cleanupClientProcess(clientId);
  }
}

function cleanupClientProcess(clientId: string): void {
  const clientProcess = clientProcesses.get(clientId);
  if (clientProcess) {
    processClients.delete(clientProcess.processId);
    clientProcesses.delete(clientId);
  }
}

let outputHandlerRegistered = false;

function ensureOutputHandler(): void {
  if (!outputHandlerRegistered) {
    onProcessOutput(handleProcessOutput);
    outputHandlerRegistered = true;
  }
}

export function handleSessionMessage(
  clientId: string,
  message: ClientMessage
): void {
  ensureOutputHandler();

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
      break;
  }
}

function handleSessionStart(
  clientId: string,
  message: ClientMessage
): void {
  const existingProcess = clientProcesses.get(clientId);
  if (existingProcess) {
    killProcess(existingProcess.processId);
    cleanupClientProcess(clientId);
  }

  let processInfo: ProcessInfo;
  try {
    processInfo = spawnClaudeProcess({
      sessionId: message.sessionId,
      projectPath: message.projectPath,
    });
  } catch (err) {
    sendToClient(clientId, {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to start session",
    });
    return;
  }

  clientProcesses.set(clientId, {
    processId: processInfo.id,
    sessionId: message.sessionId,
  });
  processClients.set(processInfo.id, clientId);

  if (message.sessionId) {
    associateClientWithSession(clientId, message.sessionId);
  }

  sendToClient(clientId, {
    type: "session.started",
    sessionId: message.sessionId || processInfo.id,
  });
}

function handleMessageSend(
  clientId: string,
  message: ClientMessage
): void {
  const clientProcess = clientProcesses.get(clientId);
  if (!clientProcess) {
    sendToClient(clientId, {
      type: "error",
      message: "No active session. Start a session first.",
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

  const jsonMessage = JSON.stringify({
    type: "user",
    content: message.content,
  });

  const success = sendToProcess(clientProcess.processId, jsonMessage);
  if (!success) {
    sendToClient(clientId, {
      type: "error",
      message: "Failed to send message to process",
    });
  }
}

function handleSessionInterrupt(clientId: string): void {
  const clientProcess = clientProcesses.get(clientId);
  if (!clientProcess) {
    sendToClient(clientId, {
      type: "error",
      message: "No active session to interrupt",
    });
    return;
  }

  interruptProcess(clientProcess.processId);
}

function handleSessionClose(clientId: string): void {
  const clientProcess = clientProcesses.get(clientId);
  if (!clientProcess) {
    return;
  }

  killProcess(clientProcess.processId);

  if (clientProcess.sessionId) {
    dissociateClientFromSession(clientId);
  }

  cleanupClientProcess(clientId);

  sendToClient(clientId, {
    type: "session.ended",
    reason: "Session closed by user",
  });
}

export function cleanupSessionHandler(): void {
  if (outputHandlerRegistered) {
    offProcessOutput(handleProcessOutput);
    outputHandlerRegistered = false;
  }
  clientProcesses.clear();
  processClients.clear();
}

export function getClientProcessId(clientId: string): string | undefined {
  return clientProcesses.get(clientId)?.processId;
}

export function getProcessClientId(processId: string): string | undefined {
  return processClients.get(processId);
}
