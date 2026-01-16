/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SessionView from './session-view';

const mockUseWebSocket = vi.fn();
vi.mock('../hooks/use-websocket', () => ({
  useWebSocket: (...args: unknown[]) => mockUseWebSocket(...args),
}));

const mockUseMessageStream = vi.fn();
vi.mock('../hooks/use-message-stream', () => ({
  useMessageStream: () => mockUseMessageStream(),
  streamingToConversation: (m: { id: string; type: string; content: unknown[] }) => ({
    type: m.type,
    uuid: m.id,
    message: { role: m.type, content: m.content },
  }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Map<string, ((event: MessageEvent) => void)[]> = new Map();
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, callback: (event: MessageEvent) => void) {
    const list = this.listeners.get(event) || [];
    list.push(callback);
    this.listeners.set(event, list);
  }

  emit(event: string, data: unknown) {
    const listeners = this.listeners.get(event) || [];
    for (const listener of listeners) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {}

  static reset() {
    MockEventSource.instances = [];
  }
}

describe('SessionView', () => {
  let originalEventSource: typeof EventSource;

  beforeEach(() => {
    originalEventSource = global.EventSource;
    global.EventSource = MockEventSource as unknown as typeof EventSource;
    MockEventSource.reset();

    mockUseWebSocket.mockReturnValue({
      status: 'connected',
      clientId: 'client-1',
      activeSessionId: null,
      hasControl: true,
      retryCount: 0,
      send: vi.fn().mockReturnValue(true),
      startSession: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockReturnValue(true),
      interrupt: vi.fn().mockReturnValue(true),
      closeSession: vi.fn().mockReturnValue(true),
      switchMode: vi.fn().mockReturnValue(true),
      sendTerminalInput: vi.fn().mockReturnValue(true),
      resizeTerminal: vi.fn().mockReturnValue(true),
      reconnect: vi.fn(),
    });

    mockUseMessageStream.mockReturnValue({
      streamingMessages: [],
      handleChunk: vi.fn(),
      addUserMessage: vi.fn(),
      clearStreamingMessages: vi.fn(),
      isStreaming: false,
    });
  });

  afterEach(() => {
    cleanup();
    global.EventSource = originalEventSource;
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    render(<SessionView sessionId="test-session" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders chat input after messages load', async () => {
    render(<SessionView sessionId="test-session" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeInTheDocument();
    });
  });

  it('hides loading state after messages load', async () => {
    const { container } = render(<SessionView sessionId="test-session" />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(container.querySelector('.flex-1.overflow-y-auto')).toBeInTheDocument();
    });

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('shows connecting placeholder when WebSocket is disconnected', async () => {
    mockUseWebSocket.mockReturnValue({
      status: 'disconnected',
      clientId: null,
      activeSessionId: null,
      hasControl: false,
      retryCount: 0,
      send: vi.fn().mockReturnValue(false),
      startSession: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn().mockReturnValue(false),
      interrupt: vi.fn().mockReturnValue(false),
      closeSession: vi.fn().mockReturnValue(false),
      switchMode: vi.fn().mockReturnValue(false),
      sendTerminalInput: vi.fn().mockReturnValue(false),
      resizeTerminal: vi.fn().mockReturnValue(false),
      reconnect: vi.fn(),
    });

    render(<SessionView sessionId="test-session" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Connecting...')).toBeInTheDocument();
    });
  });

  it('disables chat input when WebSocket is disconnected', async () => {
    mockUseWebSocket.mockReturnValue({
      status: 'disconnected',
      clientId: null,
      activeSessionId: null,
      hasControl: false,
      retryCount: 0,
      send: vi.fn().mockReturnValue(false),
      startSession: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn().mockReturnValue(false),
      interrupt: vi.fn().mockReturnValue(false),
      closeSession: vi.fn().mockReturnValue(false),
      switchMode: vi.fn().mockReturnValue(false),
      sendTerminalInput: vi.fn().mockReturnValue(false),
      resizeTerminal: vi.fn().mockReturnValue(false),
      reconnect: vi.fn(),
    });

    render(<SessionView sessionId="test-session" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('Connecting...');
      expect(textarea).toBeDisabled();
    });
  });

  it('calls startSession when sending first message and queues message until session starts', async () => {
    const mockStartSession = vi.fn().mockReturnValue(true);
    const mockSendMessage = vi.fn().mockReturnValue(true);
    const mockAddUserMessage = vi.fn();
    let capturedOnSessionStarted: (() => void) | undefined;

    mockUseWebSocket.mockImplementation((_url: string, options: { onSessionStarted?: () => void }) => {
      capturedOnSessionStarted = options.onSessionStarted;
      return {
        status: 'connected',
        clientId: 'client-1',
        activeSessionId: null,
        hasControl: true,
        retryCount: 0,
        send: vi.fn().mockReturnValue(true),
        startSession: mockStartSession,
        sendMessage: mockSendMessage,
        interrupt: vi.fn().mockReturnValue(true),
        closeSession: vi.fn().mockReturnValue(true),
        switchMode: vi.fn().mockReturnValue(true),
        sendTerminalInput: vi.fn().mockReturnValue(true),
        resizeTerminal: vi.fn().mockReturnValue(true),
        reconnect: vi.fn(),
      };
    });

    mockUseMessageStream.mockReturnValue({
      streamingMessages: [],
      handleChunk: vi.fn(),
      addUserMessage: mockAddUserMessage,
      clearStreamingMessages: vi.fn(),
      isStreaming: false,
    });

    render(<SessionView sessionId="test-session" projectPath="/test/project" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'Hello Claude' } });

    const sendButton = screen.getByTitle('Send message');
    fireEvent.click(sendButton);

    expect(mockStartSession).toHaveBeenCalledWith('test-session', '/test/project', 'chat', undefined, undefined, true);
    expect(mockAddUserMessage).toHaveBeenCalledWith('Hello Claude');
    expect(mockSendMessage).not.toHaveBeenCalled();

    capturedOnSessionStarted?.();

    expect(mockSendMessage).toHaveBeenCalledWith('Hello Claude');
  });

  it('skips startSession when session is already active', async () => {
    const mockStartSession = vi.fn().mockReturnValue(true);
    const mockSendMessage = vi.fn().mockReturnValue(true);

    mockUseWebSocket.mockReturnValue({
      status: 'connected',
      clientId: 'client-1',
      activeSessionId: 'test-session',
      hasControl: true,
      retryCount: 0,
      send: vi.fn().mockReturnValue(true),
      startSession: mockStartSession,
      sendMessage: mockSendMessage,
      interrupt: vi.fn().mockReturnValue(true),
      closeSession: vi.fn().mockReturnValue(true),
      switchMode: vi.fn().mockReturnValue(true),
      sendTerminalInput: vi.fn().mockReturnValue(true),
      resizeTerminal: vi.fn().mockReturnValue(true),
      reconnect: vi.fn(),
    });

    render(<SessionView sessionId="test-session" projectPath="/test/project" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'Hello again' } });

    const sendButton = screen.getByTitle('Send message');
    fireEvent.click(sendButton);

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('Hello again');
  });

  it('calls interrupt when interrupt button is clicked', async () => {
    const mockInterrupt = vi.fn().mockReturnValue(true);
    const mockSendMessage = vi.fn().mockReturnValue(true);

    mockUseWebSocket.mockReturnValue({
      status: 'connected',
      clientId: 'client-1',
      activeSessionId: 'test-session',
      hasControl: true,
      retryCount: 0,
      send: vi.fn().mockReturnValue(true),
      startSession: vi.fn().mockReturnValue(true),
      sendMessage: mockSendMessage,
      interrupt: mockInterrupt,
      closeSession: vi.fn().mockReturnValue(true),
      switchMode: vi.fn().mockReturnValue(true),
      sendTerminalInput: vi.fn().mockReturnValue(true),
      resizeTerminal: vi.fn().mockReturnValue(true),
      reconnect: vi.fn(),
    });

    mockUseMessageStream.mockReturnValue({
      streamingMessages: [],
      handleChunk: vi.fn(),
      addUserMessage: vi.fn(),
      clearStreamingMessages: vi.fn(),
      isStreaming: true,
    });

    render(<SessionView sessionId="test-session" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByTitle('Interrupt')).toBeInTheDocument();
    });

    const interruptButton = screen.getByTitle('Interrupt');
    fireEvent.click(interruptButton);

    expect(mockInterrupt).toHaveBeenCalled();
  });

  it('passes correct URL to useWebSocket', () => {
    render(<SessionView sessionId="test-session" />);

    expect(mockUseWebSocket).toHaveBeenCalledWith(expect.stringMatching(/^wss?:\/\/.*\/ws$/), expect.any(Object));
  });

  it('uses ws protocol for http', () => {
    Object.defineProperty(window, 'location', {
      value: {
        protocol: 'http:',
        host: 'localhost:12000',
        hostname: 'localhost',
        port: '12000',
      },
      writable: true,
    });

    render(<SessionView sessionId="test-session" />);

    expect(mockUseWebSocket).toHaveBeenCalledWith('ws://localhost:12000/ws', expect.any(Object));
  });

  it('creates EventSource with correct URL and offset', () => {
    render(<SessionView sessionId="test-session" />);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/conversation/test-session/stream?offset=0');
  });

  it('creates new EventSource when sessionId changes', async () => {
    const { rerender } = render(<SessionView sessionId="session-1" />);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain('session-1');

    rerender(<SessionView sessionId="session-2" />);

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toContain('session-2');
  });

  it('calls handleChunk when onAssistantChunk is triggered', async () => {
    const mockHandleChunk = vi.fn();
    let capturedOnAssistantChunk: ((chunk: unknown) => void) | undefined;

    mockUseWebSocket.mockImplementation((_url: string, options: { onAssistantChunk?: (chunk: unknown) => void }) => {
      capturedOnAssistantChunk = options.onAssistantChunk;
      return {
        status: 'connected',
        clientId: 'client-1',
        activeSessionId: null,
        send: vi.fn().mockReturnValue(true),
        startSession: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn().mockReturnValue(true),
        interrupt: vi.fn().mockReturnValue(true),
        closeSession: vi.fn().mockReturnValue(true),
        switchMode: vi.fn().mockReturnValue(true),
        sendTerminalInput: vi.fn().mockReturnValue(true),
        resizeTerminal: vi.fn().mockReturnValue(true),
      };
    });

    mockUseMessageStream.mockReturnValue({
      streamingMessages: [],
      handleChunk: mockHandleChunk,
      addUserMessage: vi.fn(),
      clearStreamingMessages: vi.fn(),
      isStreaming: false,
    });

    render(<SessionView sessionId="test-session" />);

    const eventSource = MockEventSource.instances[0];
    eventSource.emit('messages', []);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Send a message...')).toBeInTheDocument();
    });

    expect(capturedOnAssistantChunk).toBeDefined();
    capturedOnAssistantChunk!('{"type":"assistant"}');

    expect(mockHandleChunk).toHaveBeenCalledWith('{"type":"assistant"}');
  });

  it('clears streaming messages when sessionId changes', async () => {
    const mockClearStreamingMessages = vi.fn();

    mockUseMessageStream.mockReturnValue({
      streamingMessages: [],
      handleChunk: vi.fn(),
      addUserMessage: vi.fn(),
      clearStreamingMessages: mockClearStreamingMessages,
      isStreaming: false,
    });

    const { rerender } = render(<SessionView sessionId="session-1" />);

    mockClearStreamingMessages.mockClear();

    rerender(<SessionView sessionId="session-2" />);

    expect(mockClearStreamingMessages).toHaveBeenCalled();
  });
});
