/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSessionModal } from "./new-session-modal";

describe("NewSessionModal", () => {
  const mockOnClose = vi.fn();
  const mockOnCreateSession = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not render when isOpen is false", () => {
    render(
      <NewSessionModal
        isOpen={false}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    expect(screen.queryByText("New Session")).not.toBeInTheDocument();
  });

  it("renders when isOpen is true", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ path: "/path/to/project", name: "project" }]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    expect(screen.getByText("New Session")).toBeInTheDocument();
  });

  it("fetches projects when opened", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { path: "/path/to/project1", name: "project1" },
        { path: "/path/to/project2", name: "project2" },
      ]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/projects");
    });

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching projects", () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise(() => {})
    );

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows message when no projects found", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("No projects found")).toBeInTheDocument();
    });
  });

  it("calls onClose when clicking backdrop", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ path: "/path", name: "project" }]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    const backdrop = document.querySelector(".fixed.inset-0");
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(mockOnClose).toHaveBeenCalled();
    }
  });

  it("calls onCreateSession with selected project when submitted", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { path: "/path/to/project1", name: "project1" },
      ]),
    });

    const user = userEvent.setup();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Start Session"));

    expect(mockOnCreateSession).toHaveBeenCalledWith("/path/to/project1");
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("disables submit button when no project selected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("No projects found")).toBeInTheDocument();
    });

    expect(screen.getByText("Start Session")).toBeDisabled();
  });

  it("shows project path below dropdown", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { path: "/path/to/project1", name: "project1" },
      ]),
    });

    render(
      <NewSessionModal
        isOpen={true}
        onClose={mockOnClose}
        onCreateSession={mockOnCreateSession}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("/path/to/project1")).toBeInTheDocument();
    });
  });
});
