/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "./chat-input";

afterEach(() => {
  cleanup();
});

describe("ChatInput", () => {
  it("renders with placeholder", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText("Send a message...")).toBeDefined();
  });

  it("renders with custom placeholder", () => {
    render(<ChatInput onSend={vi.fn()} placeholder="Type here..." />);
    expect(screen.getByPlaceholderText("Type here...")).toBeDefined();
  });

  it("calls onSend when clicking send button with text", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "Hello world");
    await user.click(screen.getByTitle("Send message"));

    expect(onSend).toHaveBeenCalledWith("Hello world");
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    render(<ChatInput onSend={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(
      "Send a message..."
    ) as HTMLTextAreaElement;
    await user.type(textarea, "Hello world");
    await user.click(screen.getByTitle("Send message"));

    expect(textarea.value).toBe("");
  });

  it("calls onSend when pressing Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "Hello{Enter}");

    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("does not call onSend when pressing Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "Hello{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend with empty input", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    await user.click(screen.getByTitle("Send message"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend with whitespace-only input", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "   ");
    await user.click(screen.getByTitle("Send message"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("trims whitespace from message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "  Hello world  ");
    await user.click(screen.getByTitle("Send message"));

    expect(onSend).toHaveBeenCalledWith("Hello world");
  });

  it("disables textarea when disabled prop is true", () => {
    render(<ChatInput onSend={vi.fn()} disabled />);
    const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("does not send when disabled", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} disabled />);

    const textarea = screen.getByPlaceholderText("Send a message...");
    await user.type(textarea, "Hello");
    await user.click(screen.getByTitle("Send message"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows interrupt button when isProcessing is true", () => {
    render(<ChatInput onSend={vi.fn()} onInterrupt={vi.fn()} isProcessing />);
    expect(screen.getByTitle("Interrupt")).toBeDefined();
  });

  it("hides send button when isProcessing is true", () => {
    render(<ChatInput onSend={vi.fn()} onInterrupt={vi.fn()} isProcessing />);
    expect(screen.queryByTitle("Send message")).toBeNull();
  });

  it("calls onInterrupt when clicking interrupt button", async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    render(<ChatInput onSend={vi.fn()} onInterrupt={onInterrupt} isProcessing />);

    await user.click(screen.getByTitle("Interrupt"));

    expect(onInterrupt).toHaveBeenCalled();
  });

  it("shows send button when isProcessing is true but onInterrupt is not provided", () => {
    render(<ChatInput onSend={vi.fn()} isProcessing />);
    expect(screen.getByTitle("Send message")).toBeDefined();
    expect(screen.queryByTitle("Interrupt")).toBeNull();
  });
});
