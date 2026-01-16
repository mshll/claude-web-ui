import * as pty from "node-pty";
import { EventEmitter } from "events";

export interface PtyOptions {
  sessionId?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
}

export interface PtyInfo {
  id: string;
  pty: pty.IPty;
  sessionId?: string;
  projectPath?: string;
  startedAt: number;
}

export interface PtyOutput {
  type: "data" | "exit";
  data?: string;
  exitCode?: number;
}

export type PtyOutputHandler = (ptyId: string, output: PtyOutput) => void;

const MAX_CONCURRENT_PTYS = 10;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

const ptys = new Map<string, PtyInfo>();
const emitter = new EventEmitter();

function generatePtyId(): string {
  return `pty-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function spawnClaudePty(options: PtyOptions = {}): PtyInfo {
  if (ptys.size >= MAX_CONCURRENT_PTYS) {
    throw new Error(`Maximum concurrent PTYs (${MAX_CONCURRENT_PTYS}) reached`);
  }

  const ptyId = generatePtyId();
  const cwd = options.projectPath || process.cwd();
  const cols = options.cols || DEFAULT_COLS;
  const rows = options.rows || DEFAULT_ROWS;

  const args: string[] = [];
  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  const shellArgs =
    process.platform === "win32"
      ? ["/c", "claude", ...args]
      : ["-c", `claude ${args.join(" ")}`];

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  const ptyInfo: PtyInfo = {
    id: ptyId,
    pty: ptyProcess,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    startedAt: Date.now(),
  };

  ptys.set(ptyId, ptyInfo);

  ptyProcess.onData((data: string) => {
    emitter.emit("output", ptyId, { type: "data", data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    emitter.emit("output", ptyId, { type: "exit", exitCode });
    ptys.delete(ptyId);
  });

  return ptyInfo;
}

export function writeToPty(ptyId: string, data: string): boolean {
  const ptyInfo = ptys.get(ptyId);
  if (!ptyInfo) {
    return false;
  }
  ptyInfo.pty.write(data);
  return true;
}

export function resizePty(
  ptyId: string,
  cols: number,
  rows: number
): boolean {
  const ptyInfo = ptys.get(ptyId);
  if (!ptyInfo) {
    return false;
  }
  ptyInfo.pty.resize(cols, rows);
  return true;
}

export function killPty(ptyId: string): boolean {
  const ptyInfo = ptys.get(ptyId);
  if (!ptyInfo) {
    return false;
  }
  ptyInfo.pty.kill();
  ptys.delete(ptyId);
  return true;
}

export function getPty(ptyId: string): PtyInfo | undefined {
  return ptys.get(ptyId);
}

export function getActivePtys(): PtyInfo[] {
  return Array.from(ptys.values());
}

export function getPtyCount(): number {
  return ptys.size;
}

export function onPtyOutput(handler: PtyOutputHandler): void {
  emitter.on("output", handler);
}

export function offPtyOutput(handler: PtyOutputHandler): void {
  emitter.off("output", handler);
}

export function killAllPtys(): void {
  for (const ptyInfo of ptys.values()) {
    ptyInfo.pty.kill();
  }
  ptys.clear();
}

export function getMaxConcurrentPtys(): number {
  return MAX_CONCURRENT_PTYS;
}
