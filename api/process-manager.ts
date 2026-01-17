import { spawn, ChildProcess, execSync } from "child_process";
import { EventEmitter } from "events";

const isWindows = process.platform === "win32";

function findClaudeCommand(): string {
  if (isWindows) {
    try {
      const result = execSync("where claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const firstLine = result.trim().split(/\r?\n/)[0];
      return firstLine || "claude";
    } catch {
      return "claude.cmd";
    }
  }
  return "claude";
}

export interface ProcessOptions {
  sessionId?: string;
  projectPath?: string;
  model?: string;
  dangerouslySkipPermissions?: boolean;
}

export interface ProcessInfo {
  id: string;
  process: ChildProcess;
  sessionId?: string;
  projectPath?: string;
  startedAt: number;
  status: "starting" | "running" | "stopped";
}

export interface ProcessOutput {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  code?: number | null;
  signal?: string | null;
  error?: string;
}

export type OutputHandler = (processId: string, output: ProcessOutput) => void;

const MAX_CONCURRENT_PROCESSES = 10;

const processes = new Map<string, ProcessInfo>();
const emitter = new EventEmitter();

function generateProcessId(): string {
  return `proc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildClaudeArgs(options: ProcessOptions): string[] {
  const args: string[] = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

export function spawnClaudeProcess(options: ProcessOptions = {}): ProcessInfo {
  if (processes.size >= MAX_CONCURRENT_PROCESSES) {
    throw new Error(
      `Maximum concurrent processes (${MAX_CONCURRENT_PROCESSES}) reached`
    );
  }

  const processId = generateProcessId();
  const args = buildClaudeArgs(options);
  const cwd = options.projectPath || process.cwd();
  const claudeCmd = findClaudeCommand();

  const child = spawn(claudeCmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
    shell: isWindows,
    windowsHide: true,
  });

  const processInfo: ProcessInfo = {
    id: processId,
    process: child,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    startedAt: Date.now(),
    status: "starting",
  };

  processes.set(processId, processInfo);

  child.on("spawn", () => {
    processInfo.status = "running";
  });

  child.stdout?.on("data", (data: Buffer) => {
    processInfo.status = "running";
    emitter.emit("output", processId, {
      type: "stdout",
      data: data.toString(),
    });
  });

  child.stderr?.on("data", (data: Buffer) => {
    emitter.emit("output", processId, {
      type: "stderr",
      data: data.toString(),
    });
  });

  child.on("error", (err: Error) => {
    processInfo.status = "stopped";
    emitter.emit("output", processId, {
      type: "error",
      error: err.message,
    });
    processes.delete(processId);
  });

  child.on("exit", (code, signal) => {
    processInfo.status = "stopped";
    emitter.emit("output", processId, {
      type: "exit",
      code,
      signal: signal ?? undefined,
    });
    processes.delete(processId);
  });

  return processInfo;
}

export function sendToProcess(processId: string, message: string): boolean {
  const processInfo = processes.get(processId);
  if (!processInfo || !processInfo.process.stdin?.writable) {
    return false;
  }

  processInfo.process.stdin.write(message + "\n");
  return true;
}

export function interruptProcess(processId: string): boolean {
  const processInfo = processes.get(processId);
  if (!processInfo) {
    return false;
  }

  if (isWindows) {
    processInfo.process.stdin?.write("\x03");
  } else {
    processInfo.process.kill("SIGINT");
  }
  return true;
}

export function killProcess(processId: string): boolean {
  const processInfo = processes.get(processId);
  if (!processInfo) {
    return false;
  }

  processInfo.process.kill("SIGTERM");
  processes.delete(processId);
  return true;
}

export function getProcess(processId: string): ProcessInfo | undefined {
  return processes.get(processId);
}

export function getActiveProcesses(): ProcessInfo[] {
  return Array.from(processes.values());
}

export function getProcessCount(): number {
  return processes.size;
}

export function onProcessOutput(handler: OutputHandler): void {
  emitter.on("output", handler);
}

export function offProcessOutput(handler: OutputHandler): void {
  emitter.off("output", handler);
}

export function killAllProcesses(): void {
  for (const processInfo of processes.values()) {
    processInfo.process.kill("SIGTERM");
  }
  processes.clear();
}

export function getMaxConcurrentProcesses(): number {
  return MAX_CONCURRENT_PROCESSES;
}
