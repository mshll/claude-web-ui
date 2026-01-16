import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onReady?: (terminal: Terminal) => void;
}

export function TerminalView({ onInput, onResize, onReady }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      fitAddonRef.current.fit();
      onResize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [onResize]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#fafafa",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.onData((data) => {
      onInput(data);
    });

    terminal.onResize(({ cols, rows }) => {
      onResize(cols, rows);
    });

    onReady?.(terminal);

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(containerRef.current);

    const handleFocus = () => setIsFocused(true);
    const handleBlur = () => setIsFocused(false);

    terminal.textarea?.addEventListener('focus', handleFocus);
    terminal.textarea?.addEventListener('blur', handleBlur);

    return () => {
      terminal.textarea?.removeEventListener('focus', handleFocus);
      terminal.textarea?.removeEventListener('blur', handleBlur);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onInput, onResize, onReady, handleResize]);

  const handleContainerClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-zinc-950"
      data-testid="terminal-container"
      onClick={handleContainerClick}
    >
      {!isFocused && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-md border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-500">
            Click to focus terminal
          </span>
        </div>
      )}
    </div>
  );
}

export function useTerminalWriter() {
  const terminalRef = useRef<Terminal | null>(null);

  const setTerminal = useCallback((terminal: Terminal | null) => {
    terminalRef.current = terminal;
  }, []);

  const write = useCallback((data: string) => {
    terminalRef.current?.write(data);
  }, []);

  const clear = useCallback(() => {
    terminalRef.current?.clear();
  }, []);

  return { setTerminal, write, clear };
}
