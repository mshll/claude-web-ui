import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { ConversationMessage } from "@claude-run/api";
import { MessageSquare, Terminal as TerminalIcon } from "lucide-react";
import MessageBlock from "./message-block";
import ScrollToBottomButton from "./scroll-to-bottom-button";
import { ChatInput } from "./chat-input";
import { ConnectionStatusIndicator } from "./connection-status";
import { TerminalView, useTerminalWriter } from "./terminal-view";
import { useWebSocket } from "../hooks/use-websocket";
import {
  useMessageStream,
  streamingToConversation,
} from "../hooks/use-message-stream";

const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const SCROLL_THRESHOLD_PX = 100;

type ViewMode = "chat" | "terminal";

interface SessionViewProps {
  sessionId?: string;
  projectPath?: string;
}

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

interface ModeToggleProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  disabled?: boolean;
}

function ModeToggle({ mode, onModeChange, disabled }: ModeToggleProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-zinc-800/50 p-1">
      <button
        type="button"
        onClick={() => onModeChange("chat")}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
          mode === "chat"
            ? "bg-zinc-700 text-zinc-100"
            : "text-zinc-400 hover:text-zinc-200"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        aria-pressed={mode === "chat"}
        data-testid="mode-toggle-chat"
      >
        <MessageSquare className="h-3.5 w-3.5" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onModeChange("terminal")}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
          mode === "terminal"
            ? "bg-zinc-700 text-zinc-100"
            : "text-zinc-400 hover:text-zinc-200"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        aria-pressed={mode === "terminal"}
        data-testid="mode-toggle-terminal"
      >
        <TerminalIcon className="h-3.5 w-3.5" />
        Terminal
      </button>
    </div>
  );
}

function SessionView(props: SessionViewProps) {
  const { sessionId, projectPath } = props;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const isScrollingProgrammaticallyRef = useRef(false);
  const retryCountRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const terminalDimensionsRef = useRef({ cols: 120, rows: 30 });

  const { setTerminal, write: writeToTerminal } = useTerminalWriter();

  const {
    streamingMessages,
    handleChunk,
    addUserMessage,
    clearStreamingMessages,
    isStreaming,
  } = useMessageStream();

  const {
    status: wsStatus,
    activeSessionId,
    startSession,
    sendMessage,
    interrupt,
    switchMode,
    sendTerminalInput,
    resizeTerminal,
  } = useWebSocket(getWebSocketUrl(), {
    onSessionStarted: () => {
      // Session started
    },
    onAssistantChunk: (chunk) => {
      handleChunk(chunk);
    },
    onTerminalOutput: (data) => {
      writeToTerminal(data);
    },
    onSessionEnded: () => {
      // Session ended
    },
    onError: () => {
      // Error occurred
    },
  });

  const connect = useCallback(() => {
    if (!mountedRef.current || !sessionId) {
      setLoading(false);
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(
      `/api/conversation/${sessionId}/stream?offset=${offsetRef.current}`
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("messages", (event) => {
      retryCountRef.current = 0;
      const newMessages: ConversationMessage[] = JSON.parse(event.data);
      setLoading(false);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.uuid).filter(Boolean));
        const unique = newMessages.filter((m) => !existingIds.has(m.uuid));
        if (unique.length === 0) {
          return prev;
        }
        offsetRef.current += unique.length;
        return [...prev, ...unique];
      });
    });

    eventSource.onerror = () => {
      eventSource.close();
      setLoading(false);

      if (!mountedRef.current) {
        return;
      }

      if (retryCountRef.current < MAX_RETRIES) {
        const delay = Math.min(
          BASE_RETRY_DELAY_MS * Math.pow(2, retryCountRef.current),
          MAX_RETRY_DELAY_MS
        );
        retryCountRef.current++;
        retryTimeoutRef.current = setTimeout(() => connect(), delay);
      }
    };
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setMessages([]);
    offsetRef.current = 0;
    retryCountRef.current = 0;
    clearStreamingMessages();

    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [connect, clearStreamingMessages]);

  const scrollToBottom = useCallback(() => {
    if (!lastMessageRef.current) {
      return;
    }
    isScrollingProgrammaticallyRef.current = true;
    lastMessageRef.current.scrollIntoView({ behavior: "instant" });
    requestAnimationFrame(() => {
      isScrollingProgrammaticallyRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
  }, [messages, streamingMessages, autoScroll, scrollToBottom]);

  const handleScroll = () => {
    if (!containerRef.current || isScrollingProgrammaticallyRef.current) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom =
      scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD_PX;
    setAutoScroll(isAtBottom);
  };

  const handleSendMessage = useCallback(
    (content: string) => {
      if (wsStatus !== "connected") {
        return;
      }

      if (!activeSessionId) {
        startSession(sessionId, projectPath, "chat");
      }

      addUserMessage(content);
      sendMessage(content);
    },
    [
      wsStatus,
      activeSessionId,
      sessionId,
      projectPath,
      startSession,
      sendMessage,
      addUserMessage,
    ]
  );

  const handleInterrupt = useCallback(() => {
    interrupt();
  }, [interrupt]);

  const handleModeChange = useCallback(
    (newMode: ViewMode) => {
      if (newMode === viewMode) return;
      setViewMode(newMode);

      if (activeSessionId) {
        const { cols, rows } = terminalDimensionsRef.current;
        switchMode(newMode, cols, rows);
      }
    },
    [viewMode, activeSessionId, switchMode]
  );

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (wsStatus !== "connected") return;

      if (!activeSessionId) {
        const { cols, rows } = terminalDimensionsRef.current;
        startSession(sessionId, projectPath, "terminal", cols, rows);
      }

      sendTerminalInput(data);
    },
    [wsStatus, activeSessionId, sessionId, projectPath, startSession, sendTerminalInput]
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      terminalDimensionsRef.current = { cols, rows };
      if (activeSessionId && viewMode === "terminal") {
        resizeTerminal(cols, rows);
      }
    },
    [activeSessionId, viewMode, resizeTerminal]
  );

  const summary = messages.find((m) => m.type === "summary");
  const historicalMessages = messages.filter(
    (m) => m.type === "user" || m.type === "assistant"
  );

  const streamingConversationMessages = useMemo(
    () => streamingMessages.map(streamingToConversation),
    [streamingMessages]
  );

  const allMessages = useMemo(
    () => [...historicalMessages, ...streamingConversationMessages],
    [historicalMessages, streamingConversationMessages]
  );

  const isConnected = wsStatus === "connected";

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/50 px-4 py-2">
        <ModeToggle
          mode={viewMode}
          onModeChange={handleModeChange}
          disabled={!isConnected}
        />
        <ConnectionStatusIndicator status={wsStatus} />
      </div>

      {viewMode === "chat" ? (
        <>
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto bg-zinc-950"
          >
            <div className="mx-auto max-w-3xl px-4 py-4">
              {summary && (
                <div className="mb-6 rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-4">
                  <h2 className="text-sm font-medium text-zinc-200 leading-relaxed">
                    {summary.summary}
                  </h2>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    {allMessages.length} messages
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {allMessages.map((message, index) => (
                  <div
                    key={message.uuid || index}
                    ref={
                      index === allMessages.length - 1
                        ? lastMessageRef
                        : undefined
                    }
                  >
                    <MessageBlock message={message} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {!autoScroll && (
            <ScrollToBottomButton
              onClick={() => {
                setAutoScroll(true);
                scrollToBottom();
              }}
            />
          )}

          <ChatInput
            onSend={handleSendMessage}
            onInterrupt={handleInterrupt}
            disabled={!isConnected}
            isProcessing={isStreaming}
            placeholder={isConnected ? "Send a message..." : "Connecting..."}
          />
        </>
      ) : (
        <div className="flex-1 overflow-hidden">
          <TerminalView
            onInput={handleTerminalInput}
            onResize={handleTerminalResize}
            onReady={setTerminal}
          />
        </div>
      )}
    </div>
  );
}

export default SessionView;
