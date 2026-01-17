import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage } from '@claude-web-ui/api';
import { MessageSquare, Terminal as TerminalIcon, ShieldOff, Loader2 } from 'lucide-react';
import MessageBlock from './message-block';
import ScrollToBottomButton from './scroll-to-bottom-button';
import { ChatInput } from './chat-input';
import { ConnectionStatusIndicator } from './connection-status';
import { TerminalView, useTerminalWriter } from './terminal-view';
import { useWebSocket } from '../hooks/use-websocket';
import { useMessageStream, streamingToConversation } from '../hooks/use-message-stream';

const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const SCROLL_THRESHOLD_PX = 100;

function getWebSocketUrl(): string {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envUrl) {
    return envUrl;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const { host } = window.location;

  return `${protocol}//${host}/ws`;
}

type ViewMode = 'chat' | 'terminal';

interface SessionViewProps {
  sessionId?: string;
  projectPath?: string;
}

interface ModeToggleProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  disabled?: boolean;
}

function ModeToggle({ mode, onModeChange, disabled }: ModeToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-zinc-900 p-0.5">
      <button
        type="button"
        onClick={() => onModeChange('chat')}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
          mode === 'chat' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        aria-pressed={mode === 'chat'}
        data-testid="mode-toggle-chat"
      >
        <MessageSquare className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onModeChange('terminal')}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
          mode === 'terminal' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        aria-pressed={mode === 'terminal'}
        data-testid="mode-toggle-terminal"
      >
        <TerminalIcon className="h-3 w-3" />
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
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [skipPermissions, setSkipPermissions] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const isScrollingProgrammaticallyRef = useRef(false);
  const retryCountRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const terminalDimensionsRef = useRef({ cols: 120, rows: 30 });
  const pendingMessageRef = useRef<string | null>(null);
  const sessionStartingRef = useRef(false);
  const wsSendMessageRef = useRef<((content: string) => boolean) | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);

  const wsUrl = useMemo(() => getWebSocketUrl(), []);

  const { setTerminal, write: writeToTerminal } = useTerminalWriter();

  const { streamingMessages, handleChunk, addUserMessage, clearStreamingMessages, isStreaming } = useMessageStream();

  const handleSessionStarted = useCallback(() => {
    sessionStartingRef.current = false;
    if (pendingMessageRef.current && wsSendMessageRef.current) {
      const pending = pendingMessageRef.current;
      pendingMessageRef.current = null;
      wsSendMessageRef.current(pending);
    }
  }, []);

  const handleAssistantChunk = useCallback(
    (chunk: unknown) => {
      handleChunk(chunk);
      setWsError(null);
      setIsWaitingForResponse(false);
    },
    [handleChunk],
  );

  const handleTerminalOutput = useCallback(
    (data: string) => {
      writeToTerminal(data);
    },
    [writeToTerminal],
  );

  const handleSessionEnded = useCallback(() => {
    sessionStartingRef.current = false;
    pendingMessageRef.current = null;
    setIsWaitingForResponse(false);
  }, []);

  const handleWsError = useCallback((message: string) => {
    setWsError(message);
    sessionStartingRef.current = false;
    setIsWaitingForResponse(false);
  }, []);

  const wsOptions = useMemo(
    () => ({
      onSessionStarted: handleSessionStarted,
      onAssistantChunk: handleAssistantChunk,
      onTerminalOutput: handleTerminalOutput,
      onSessionEnded: handleSessionEnded,
      onError: handleWsError,
    }),
    [handleSessionStarted, handleAssistantChunk, handleTerminalOutput, handleSessionEnded, handleWsError],
  );

  const {
    status: wsStatus,
    activeSessionId,
    hasControl,
    retryCount: wsRetryCount,
    startSession,
    sendMessage: wsSendMessage,
    interrupt,
    switchMode,
    sendTerminalInput,
    resizeTerminal,
    reconnect,
  } = useWebSocket(wsUrl, wsOptions);

  wsSendMessageRef.current = wsSendMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current || !sessionId) {
      setLoading(false);
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/conversation/${sessionId}/stream?offset=${offsetRef.current}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('messages', (event) => {
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
    lastMessageRef.current.scrollIntoView({ behavior: 'instant' });
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

  const handleSendMessage = useCallback(
    (content: string) => {
      if (wsStatus !== 'connected') {
        return;
      }

      setWsError(null);
      setIsWaitingForResponse(true);
      addUserMessage(content);

      if (!activeSessionId && !sessionStartingRef.current) {
        sessionStartingRef.current = true;
        pendingMessageRef.current = content;
        startSession(sessionId, projectPath, 'chat', undefined, undefined, skipPermissions);
      } else if (activeSessionId) {
        wsSendMessage(content);
      } else {
        pendingMessageRef.current = content;
      }
    },
    [wsStatus, activeSessionId, sessionId, projectPath, startSession, wsSendMessage, addUserMessage, skipPermissions],
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
      } else if (newMode === 'terminal' && wsStatus === 'connected') {
        const { cols, rows } = terminalDimensionsRef.current;
        startSession(sessionId, projectPath, 'terminal', cols, rows, skipPermissions);
      }
    },
    [viewMode, activeSessionId, switchMode, wsStatus, sessionId, projectPath, startSession, skipPermissions],
  );

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (wsStatus !== 'connected') return;

      if (!activeSessionId) {
        const { cols, rows } = terminalDimensionsRef.current;
        startSession(sessionId, projectPath, 'terminal', cols, rows, skipPermissions);
      }

      sendTerminalInput(data);
    },
    [wsStatus, activeSessionId, sessionId, projectPath, startSession, sendTerminalInput, skipPermissions],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      terminalDimensionsRef.current = { cols, rows };
      if (activeSessionId && viewMode === 'terminal') {
        resizeTerminal(cols, rows);
      }
    },
    [activeSessionId, viewMode, resizeTerminal],
  );

  const summary = messages.find((m) => m.type === 'summary');
  const historicalMessages = messages.filter((m) => m.type === 'user' || m.type === 'assistant');

  const streamingConversationMessages = useMemo(() => streamingMessages.map(streamingToConversation), [streamingMessages]);

  const allMessages = useMemo(() => {
    if (streamingConversationMessages.length === 0) {
      return historicalMessages;
    }

    const firstStreamingUserContent = streamingConversationMessages.find((m) => m.type === 'user');
    if (!firstStreamingUserContent) {
      return [...historicalMessages, ...streamingConversationMessages];
    }

    const userContent =
      firstStreamingUserContent.message?.content?.[0]?.type === 'text'
        ? (firstStreamingUserContent.message.content[0] as { text: string }).text
        : null;

    if (!userContent) {
      return [...historicalMessages, ...streamingConversationMessages];
    }

    const matchIndex = historicalMessages.findIndex((m) => {
      if (m.type !== 'user') return false;
      const content = m.message?.content;
      if (Array.isArray(content) && content[0]?.type === 'text') {
        return (content[0] as { text: string }).text === userContent;
      }
      return false;
    });

    if (matchIndex >= 0) {
      return historicalMessages;
    }

    return [...historicalMessages, ...streamingConversationMessages];
  }, [historicalMessages, streamingConversationMessages]);

  const isConnected = wsStatus === 'connected';
  const canSendMessages = isConnected && (hasControl || !activeSessionId);

  const getPlaceholder = () => {
    if (!isConnected) {
      if (wsRetryCount > 0) {
        return `Reconnecting... (attempt ${wsRetryCount})`;
      }
      return 'Connecting...';
    }
    if (activeSessionId && !hasControl) {
      return 'Another tab controls this session';
    }
    return 'Send a message...';
  };

  const portalTarget = document.getElementById('session-controls-portal');

  const sessionControls = (
    <>
      <button
        type="button"
        onClick={() => setSkipPermissions(!skipPermissions)}
        disabled={!!activeSessionId}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
          skipPermissions ? 'bg-red-500/15 text-red-400' : 'text-zinc-500 hover:text-zinc-300'
        } ${activeSessionId ? 'cursor-not-allowed opacity-50' : ''}`}
        title={skipPermissions ? 'Bypass permissions enabled' : 'Bypass permissions disabled'}
      >
        <ShieldOff className="h-3 w-3" />
        {skipPermissions ? 'Bypass permissions' : 'Normal'}
      </button>
      <ModeToggle mode={viewMode} onModeChange={handleModeChange} disabled={!isConnected} />
      <ConnectionStatusIndicator status={wsStatus} />
    </>
  );

  if (loading) {
    return <div className="flex h-full items-center justify-center text-zinc-500">Loading...</div>;
  }

  return (
    <div className="relative flex h-full flex-col">
      {portalTarget && createPortal(sessionControls, portalTarget)}
      {viewMode === 'chat' ? (
        <>
          <div className="relative flex-1 overflow-hidden">
            <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto bg-zinc-950">
              <div className="mx-auto max-w-3xl px-4 py-4 pb-24">
                {summary && (
                  <div className="mb-6 rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-4">
                    <h2 className="text-sm font-medium text-zinc-200 leading-relaxed">{summary.summary}</h2>
                    <p className="mt-2 text-[11px] text-zinc-500">{allMessages.length} messages</p>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {allMessages.map((message, index) => (
                    <div key={message.uuid || index} ref={index === allMessages.length - 1 && !isStreaming ? lastMessageRef : undefined}>
                      <MessageBlock message={message} />
                    </div>
                  ))}
                  {(isStreaming || isWaitingForResponse) && (
                    <div ref={lastMessageRef} className="flex items-center gap-2 py-3">
                      <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                      <span className="text-sm text-zinc-500">Thinking...</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {(wsError || !autoScroll) && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-center justify-center px-4 pb-3 pt-8"
                style={{ background: 'linear-gradient(to bottom, transparent, rgb(9 9 11) 100%)' }}
              >
                <div className="flex w-full max-w-3xl items-center justify-between">
                  <div className="pointer-events-auto">
                    {wsError && (
                      <span className="text-sm text-red-400">{wsError}</span>
                    )}
                  </div>
                  <div className="pointer-events-auto">
                    {!autoScroll && (
                      <ScrollToBottomButton
                        onClick={() => {
                          setAutoScroll(true);
                          scrollToBottom();
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <ChatInput
            onSend={handleSendMessage}
            onInterrupt={handleInterrupt}
            disabled={!canSendMessages}
            isProcessing={isStreaming || isWaitingForResponse}
            placeholder={getPlaceholder()}
          />
        </>
      ) : (
        <div className="flex-1 overflow-hidden">
          <TerminalView onInput={handleTerminalInput} onResize={handleTerminalResize} onReady={setTerminal} />
        </div>
      )}
    </div>
  );
}

export default SessionView;
