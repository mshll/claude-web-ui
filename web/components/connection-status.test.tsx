/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConnectionStatusIndicator } from "./connection-status";

afterEach(() => {
  cleanup();
});

describe("ConnectionStatusIndicator", () => {
  it("renders connected status with green indicator", () => {
    render(<ConnectionStatusIndicator status="connected" />);
    expect(screen.getByText("Connected")).toBeDefined();
    const indicator = document.querySelector(".bg-emerald-500");
    expect(indicator).not.toBeNull();
  });

  it("renders connecting status with amber indicator", () => {
    render(<ConnectionStatusIndicator status="connecting" />);
    expect(screen.getByText("Connecting")).toBeDefined();
    const indicator = document.querySelector(".bg-amber-500");
    expect(indicator).not.toBeNull();
  });

  it("renders disconnected status with zinc indicator", () => {
    render(<ConnectionStatusIndicator status="disconnected" />);
    expect(screen.getByText("Disconnected")).toBeDefined();
    const indicator = document.querySelector(".bg-zinc-500");
    expect(indicator).not.toBeNull();
  });

  it("applies pulse animation to connecting status", () => {
    render(<ConnectionStatusIndicator status="connecting" />);
    const indicator = document.querySelector(".animate-pulse");
    expect(indicator).not.toBeNull();
  });

  it("does not apply pulse animation to connected status", () => {
    render(<ConnectionStatusIndicator status="connected" />);
    const indicator = document.querySelector(".animate-pulse");
    expect(indicator).toBeNull();
  });

  it("does not apply pulse animation to disconnected status", () => {
    render(<ConnectionStatusIndicator status="disconnected" />);
    const indicator = document.querySelector(".animate-pulse");
    expect(indicator).toBeNull();
  });
});
