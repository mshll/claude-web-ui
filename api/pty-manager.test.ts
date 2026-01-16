import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node-pty", () => {
  const mockPty = {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return {
    spawn: vi.fn(() => mockPty),
  };
});

import * as pty from "node-pty";
import {
  spawnClaudePty,
  writeToPty,
  resizePty,
  killPty,
  getPty,
  getActivePtys,
  getPtyCount,
  onPtyOutput,
  offPtyOutput,
  killAllPtys,
  getMaxConcurrentPtys,
} from "./pty-manager";

describe("pty-manager", () => {
  let mockPty: {
    onData: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    killAllPtys();

    mockPty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.mocked(pty.spawn).mockReturnValue(mockPty as unknown as pty.IPty);
  });

  afterEach(() => {
    killAllPtys();
  });

  describe("spawnClaudePty", () => {
    it("spawns a PTY with default options", () => {
      const ptyInfo = spawnClaudePty();

      expect(pty.spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["-c", "claude "],
        expect.objectContaining({
          name: "xterm-256color",
          cols: 120,
          rows: 30,
        })
      );
      expect(ptyInfo.id).toMatch(/^pty-/);
      expect(ptyInfo.pty).toBe(mockPty);
    });

    it("spawns a PTY with sessionId for resume", () => {
      spawnClaudePty({ sessionId: "test-session-123" });

      expect(pty.spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["-c", "claude --resume test-session-123"],
        expect.any(Object)
      );
    });

    it("spawns a PTY with custom dimensions", () => {
      spawnClaudePty({ cols: 80, rows: 24 });

      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cols: 80,
          rows: 24,
        })
      );
    });

    it("spawns a PTY with projectPath as cwd", () => {
      spawnClaudePty({ projectPath: "/test/path" });

      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cwd: "/test/path",
        })
      );
    });

    it("stores PTY info correctly", () => {
      const ptyInfo = spawnClaudePty({
        sessionId: "test-session",
        projectPath: "/test/path",
      });

      expect(ptyInfo.sessionId).toBe("test-session");
      expect(ptyInfo.projectPath).toBe("/test/path");
      expect(ptyInfo.startedAt).toBeGreaterThan(0);
    });

    it("increments PTY count", () => {
      expect(getPtyCount()).toBe(0);
      spawnClaudePty();
      expect(getPtyCount()).toBe(1);
      spawnClaudePty();
      expect(getPtyCount()).toBe(2);
    });

    it("throws when max concurrent PTYs reached", () => {
      const maxPtys = getMaxConcurrentPtys();

      for (let i = 0; i < maxPtys; i++) {
        spawnClaudePty();
      }

      expect(() => spawnClaudePty()).toThrow(
        `Maximum concurrent PTYs (${maxPtys}) reached`
      );
    });

    it("emits data events", () => {
      const handler = vi.fn();
      onPtyOutput(handler);

      const ptyInfo = spawnClaudePty();

      const onDataCallback = mockPty.onData.mock.calls[0][0];
      onDataCallback("test output");

      expect(handler).toHaveBeenCalledWith(ptyInfo.id, {
        type: "data",
        data: "test output",
      });

      offPtyOutput(handler);
    });

    it("emits exit events and cleans up", () => {
      const handler = vi.fn();
      onPtyOutput(handler);

      const ptyInfo = spawnClaudePty();

      const onExitCallback = mockPty.onExit.mock.calls[0][0];
      onExitCallback({ exitCode: 0 });

      expect(handler).toHaveBeenCalledWith(ptyInfo.id, {
        type: "exit",
        exitCode: 0,
      });
      expect(getPty(ptyInfo.id)).toBeUndefined();

      offPtyOutput(handler);
    });
  });

  describe("writeToPty", () => {
    it("writes data to PTY stdin", () => {
      const ptyInfo = spawnClaudePty();

      const result = writeToPty(ptyInfo.id, "hello");

      expect(result).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith("hello");
    });

    it("returns false for non-existent PTY", () => {
      const result = writeToPty("non-existent", "hello");
      expect(result).toBe(false);
    });
  });

  describe("resizePty", () => {
    it("resizes the PTY", () => {
      const ptyInfo = spawnClaudePty();

      const result = resizePty(ptyInfo.id, 100, 40);

      expect(result).toBe(true);
      expect(mockPty.resize).toHaveBeenCalledWith(100, 40);
    });

    it("returns false for non-existent PTY", () => {
      const result = resizePty("non-existent", 100, 40);
      expect(result).toBe(false);
    });
  });

  describe("killPty", () => {
    it("kills the PTY and removes from tracking", () => {
      const ptyInfo = spawnClaudePty();

      const result = killPty(ptyInfo.id);

      expect(result).toBe(true);
      expect(mockPty.kill).toHaveBeenCalled();
      expect(getPty(ptyInfo.id)).toBeUndefined();
    });

    it("returns false for non-existent PTY", () => {
      const result = killPty("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("getActivePtys", () => {
    it("returns all active PTYs", () => {
      const pty1 = spawnClaudePty({ sessionId: "session1" });
      const pty2 = spawnClaudePty({ sessionId: "session2" });

      const activePtys = getActivePtys();

      expect(activePtys).toHaveLength(2);
      expect(activePtys.map((p) => p.id)).toContain(pty1.id);
      expect(activePtys.map((p) => p.id)).toContain(pty2.id);
    });
  });

  describe("killAllPtys", () => {
    it("kills all PTYs", () => {
      spawnClaudePty();
      spawnClaudePty();
      spawnClaudePty();

      expect(getPtyCount()).toBe(3);

      killAllPtys();

      expect(getPtyCount()).toBe(0);
      expect(mockPty.kill).toHaveBeenCalledTimes(3);
    });
  });

  describe("output handlers", () => {
    it("registers and removes output handlers", () => {
      const handler = vi.fn();

      onPtyOutput(handler);
      const ptyInfo = spawnClaudePty();

      const onDataCallback = mockPty.onData.mock.calls[0][0];
      onDataCallback("test");

      expect(handler).toHaveBeenCalledTimes(1);

      offPtyOutput(handler);
      onDataCallback("test2");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
