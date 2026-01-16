import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  spawnClaudeProcess,
  sendToProcess,
  interruptProcess,
  killProcess,
  getProcess,
  getActiveProcesses,
  getProcessCount,
  onProcessOutput,
  offProcessOutput,
  killAllProcesses,
  getMaxConcurrentProcesses,
  type ProcessOutput,
} from "./process-manager";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdin = new EventEmitter() as unknown as ChildProcess["stdin"];
  Object.defineProperty(stdin, "writable", { value: true, writable: true });
  Object.defineProperty(stdin, "write", { value: vi.fn(), writable: true });

  proc.stdin = stdin;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];

  proc.kill = vi.fn().mockReturnValue(true);
  Object.defineProperty(proc, "pid", { value: Math.floor(Math.random() * 10000) });

  return proc;
}

describe("Process Manager", () => {
  let mockProcess: ChildProcess;

  beforeEach(() => {
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess);
  });

  afterEach(() => {
    killAllProcesses();
    vi.clearAllMocks();
  });

  describe("spawnClaudeProcess", () => {
    it("should spawn a claude process with default args", () => {
      const processInfo = spawnClaudeProcess();

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["--print", "--input-format", "stream-json", "--output-format", "stream-json"],
        expect.objectContaining({
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
      expect(processInfo.id).toMatch(/^proc-/);
      expect(processInfo.status).toBe("starting");
    });

    it("should include --resume flag when sessionId provided", () => {
      spawnClaudeProcess({ sessionId: "test-session-123" });

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--resume", "test-session-123"]),
        expect.any(Object)
      );
    });

    it("should include --model flag when model provided", () => {
      spawnClaudeProcess({ model: "claude-3-opus" });

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--model", "claude-3-opus"]),
        expect.any(Object)
      );
    });

    it("should use projectPath as cwd", () => {
      spawnClaudeProcess({ projectPath: "/test/project" });

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({
          cwd: "/test/project",
        })
      );
    });

    it("should store process info", () => {
      const processInfo = spawnClaudeProcess();
      const retrieved = getProcess(processInfo.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(processInfo.id);
    });

    it("should increment process count", () => {
      const initialCount = getProcessCount();
      spawnClaudeProcess();

      expect(getProcessCount()).toBe(initialCount + 1);
    });

    it("should throw when max processes reached", () => {
      const max = getMaxConcurrentProcesses();

      for (let i = 0; i < max; i++) {
        const newMock = createMockProcess();
        vi.mocked(spawn).mockReturnValueOnce(newMock);
        spawnClaudeProcess();
      }

      expect(() => spawnClaudeProcess()).toThrow(/Maximum concurrent processes/);
    });
  });

  describe("process output handling", () => {
    it("should emit stdout events", () => {
      const handler = vi.fn();
      onProcessOutput(handler);

      const processInfo = spawnClaudeProcess();
      mockProcess.stdout?.emit("data", Buffer.from("test output"));

      expect(handler).toHaveBeenCalledWith(processInfo.id, {
        type: "stdout",
        data: "test output",
      });

      offProcessOutput(handler);
    });

    it("should update status to running on stdout", () => {
      const processInfo = spawnClaudeProcess();
      expect(processInfo.status).toBe("starting");

      mockProcess.stdout?.emit("data", Buffer.from("output"));
      expect(processInfo.status).toBe("running");
    });

    it("should emit stderr events", () => {
      const handler = vi.fn();
      onProcessOutput(handler);

      const processInfo = spawnClaudeProcess();
      mockProcess.stderr?.emit("data", Buffer.from("error output"));

      expect(handler).toHaveBeenCalledWith(processInfo.id, {
        type: "stderr",
        data: "error output",
      });

      offProcessOutput(handler);
    });

    it("should emit exit events and remove process", () => {
      const handler = vi.fn();
      onProcessOutput(handler);

      const processInfo = spawnClaudeProcess();
      mockProcess.emit("exit", 0, null);

      expect(handler).toHaveBeenCalledWith(processInfo.id, {
        type: "exit",
        code: 0,
        signal: undefined,
      });
      expect(getProcess(processInfo.id)).toBeUndefined();

      offProcessOutput(handler);
    });

    it("should emit error events and remove process", () => {
      const handler = vi.fn();
      onProcessOutput(handler);

      const processInfo = spawnClaudeProcess();
      mockProcess.emit("error", new Error("spawn failed"));

      expect(handler).toHaveBeenCalledWith(processInfo.id, {
        type: "error",
        error: "spawn failed",
      });
      expect(getProcess(processInfo.id)).toBeUndefined();

      offProcessOutput(handler);
    });

    it("should allow removing output handlers", () => {
      const handler = vi.fn();
      onProcessOutput(handler);
      offProcessOutput(handler);

      spawnClaudeProcess();
      mockProcess.stdout?.emit("data", Buffer.from("output"));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("sendToProcess", () => {
    it("should write to process stdin", () => {
      const processInfo = spawnClaudeProcess();
      const result = sendToProcess(processInfo.id, '{"type":"message"}');

      expect(result).toBe(true);
      expect(mockProcess.stdin?.write).toHaveBeenCalledWith('{"type":"message"}\n');
    });

    it("should return false for non-existent process", () => {
      const result = sendToProcess("fake-process", "test");
      expect(result).toBe(false);
    });

    it("should return false when stdin not writable", () => {
      const processInfo = spawnClaudeProcess();
      (mockProcess.stdin as EventEmitter & { writable: boolean }).writable = false;

      const result = sendToProcess(processInfo.id, "test");
      expect(result).toBe(false);
    });
  });

  describe("interruptProcess", () => {
    it("should send SIGINT to process", () => {
      const processInfo = spawnClaudeProcess();
      const result = interruptProcess(processInfo.id);

      expect(result).toBe(true);
      expect(mockProcess.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("should return false for non-existent process", () => {
      const result = interruptProcess("fake-process");
      expect(result).toBe(false);
    });
  });

  describe("killProcess", () => {
    it("should send SIGTERM to process and remove from tracking", () => {
      const processInfo = spawnClaudeProcess();
      const result = killProcess(processInfo.id);

      expect(result).toBe(true);
      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect(getProcess(processInfo.id)).toBeUndefined();
    });

    it("should return false for non-existent process", () => {
      const result = killProcess("fake-process");
      expect(result).toBe(false);
    });
  });

  describe("getActiveProcesses", () => {
    it("should return all active processes", () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();

      vi.mocked(spawn).mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      const info1 = spawnClaudeProcess();
      const info2 = spawnClaudeProcess();

      const active = getActiveProcesses();
      expect(active).toHaveLength(2);
      expect(active.map((p) => p.id)).toContain(info1.id);
      expect(active.map((p) => p.id)).toContain(info2.id);
    });
  });

  describe("killAllProcesses", () => {
    it("should kill all active processes", () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();

      vi.mocked(spawn).mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      spawnClaudeProcess();
      spawnClaudeProcess();

      expect(getProcessCount()).toBe(2);

      killAllProcesses();

      expect(getProcessCount()).toBe(0);
      expect(proc1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
