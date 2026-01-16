import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { ConversationMessage } from "@claude-run/api";
import MessageBlock from "./message-block";
import ScrollToBottomButton from "./scroll-to-bottom-button";
import { ChatInput } from "./chat-input";
import { ConnectionStatusIndicator } from "./connection-status";
import { useWebSocket } from "../hooks/use-websocket";
import { useMessageStream, streamingToConversation } from "../hooks/use-message-stream";

const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const SCROLL_THRESHOLD_PX = 100;

interface SessionViewProps {
  sessionId: string;
  projectPath?: string;
}

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function SessionView(props: SessionViewProps) {
  const { sessionId, projectPath } = props;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const isScrollingProgrammaticallyRef = useRef(false);
  const retryCountRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

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
  } = useWebSocket(getWebSocketUrl(), {
    onSessionStarted: () => {
      // Session started, ready for messages
    },
    onAssistantChunk: (chunk) => {
      handleChunk(chunk);
    },
    onSessionEnded: () => {
      // Session ended
    },
    onError: () => {
      // Error occurred
    },
  });

  const connect = useCallback(() => {
    if (!mountedRef.current) {
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
        const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, retryCountRef.current), MAX_RETRY_DELAY_MS);
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
    const isAtBottom = scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD_PX;
    setAutoScroll(isAtBottom);
  };

  const handleSendMessage = useCallback((content: string) => {
    if (wsStatus !== "connected") {
      return;
    }

    if (!activeSessionId) {
      startSession(sessionId, projectPath);
    }

    addUserMessage(content);
    sendMessage(content);
  }, [wsStatus, activeSessionId, sessionId, projectPath, startSession, sendMessage, addUserMessage]);

  const handleInterrupt = useCallback(() => {
    interrupt();
  }, [interrupt]);

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
      <div className="flex items-center justify-end border-b border-zinc-800/60 bg-zinc-900/50 px-4 py-2">
        <ConnectionStatusIndicator status={wsStatus} />
      </div>
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
    </div>
  );
}

export default SessionView;
