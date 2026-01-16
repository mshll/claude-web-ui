/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTerminalWriter } from "./terminal-view";

describe("useTerminalWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns setTerminal, write, and clear functions", () => {
    const { result } = renderHook(() => useTerminalWriter());

    expect(result.current.setTerminal).toBeInstanceOf(Function);
    expect(result.current.write).toBeInstanceOf(Function);
    expect(result.current.clear).toBeInstanceOf(Function);
  });

  it("write does nothing when no terminal is set", () => {
    const mockWrite = vi.fn();
    const { result } = renderHook(() => useTerminalWriter());

    act(() => {
      result.current.write("test");
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("write writes to terminal when terminal is set", () => {
    const mockTerminal = {
      write: vi.fn(),
      clear: vi.fn(),
    };

    const { result } = renderHook(() => useTerminalWriter());

    act(() => {
      result.current.setTerminal(mockTerminal as never);
    });

    act(() => {
      result.current.write("test data");
    });

    expect(mockTerminal.write).toHaveBeenCalledWith("test data");
  });

  it("clear clears terminal when terminal is set", () => {
    const mockTerminal = {
      write: vi.fn(),
      clear: vi.fn(),
    };

    const { result } = renderHook(() => useTerminalWriter());

    act(() => {
      result.current.setTerminal(mockTerminal as never);
    });

    act(() => {
      result.current.clear();
    });

    expect(mockTerminal.clear).toHaveBeenCalled();
  });

  it("clear does nothing when no terminal is set", () => {
    const mockClear = vi.fn();
    const { result } = renderHook(() => useTerminalWriter());

    act(() => {
      result.current.clear();
    });

    expect(mockClear).not.toHaveBeenCalled();
  });
});
