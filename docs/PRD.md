# PRD: Interactive Session Continuation

## Overview

Enable users to continue Claude Code sessions directly from the web UI, transforming claude-run from a read-only viewer into an interactive chat interface.

## Goals

1. Continue existing sessions from the web UI
2. Start new sessions from the web UI
3. Support multiple concurrent sessions across browser tabs
4. Provide hybrid UI: clean chat interface with optional terminal view

## Architecture Recommendation

### Why Not Pure PTY?

A pure terminal emulator (node-pty + xterm.js) would work but has drawbacks:
- Raw terminal output is harder to parse/style
- No structured message boundaries
- Difficult to integrate with existing message rendering

### Recommended: Dual-Mode Architecture

**Mode 1 - Chat Mode (Default)**: Spawn Claude CLI with structured JSON streaming
```bash
claude --print --input-format stream-json --output-format stream-json --resume <session-id>
```
- Parse JSON messages, render in existing UI components
- Clean, styled output matching current viewer
- Full control over message rendering

**Mode 2 - Terminal Mode (Toggle)**: Full PTY with xterm.js
- For power users who want raw terminal access
- Shows exact CLI output including prompts, colors, tool confirmations
- Requires node-pty + xterm.js

### Communication Protocol

```
Browser                    Backend                     Claude CLI
   │                          │                            │
   │──WebSocket connect──────▶│                            │
   │                          │──spawn process────────────▶│
   │                          │   (--resume <id>)          │
   │                          │                            │
   │──{type:"message",────────▶│──stdin write─────────────▶│
   │   content:"..."}         │                            │
   │                          │◀──stdout JSON stream───────│
   │◀──{type:"assistant",─────│                            │
   │   content:[...]}         │                            │
   │                          │                            │
   │──{type:"interrupt"}─────▶│──SIGINT────────────────────▶│
   │                          │                            │
```

## User Experience

### Session View Changes

1. **Chat Input**: Text area at bottom of session view
   - Submit with Enter (Shift+Enter for newline)
   - Disable when no active connection

2. **Connection Status**: Indicator showing connected/disconnected/connecting

3. **Mode Toggle**: Switch between Chat Mode and Terminal Mode
   - Chat Mode: Rendered messages (current style)
   - Terminal Mode: xterm.js terminal emulator

4. **New Session Button**: In session list header
   - Opens modal to select project directory
   - Starts fresh Claude session

### Session List Changes

1. **Active Session Indicator**: Badge showing which sessions are currently running
2. **New Session Action**: Button to start new session

## Technical Requirements

### New Dependencies

```json
{
  "dependencies": {
    "ws": "^8.x",
    "node-pty": "^1.x",
    "xterm": "^5.x",
    "xterm-addon-fit": "^0.8.x",
    "xterm-addon-web-links": "^0.9.x"
  }
}
```

### Backend Changes

**New files:**
- `api/websocket.ts` - WebSocket server, connection management
- `api/process-manager.ts` - Claude CLI process spawning, lifecycle management

**Modified files:**
- `api/index.ts` - Initialize WebSocket server alongside HTTP
- `api/server.ts` - Add endpoint to list active sessions

### Frontend Changes

**New files:**
- `web/components/chat-input.tsx` - Message input component
- `web/components/terminal-view.tsx` - xterm.js wrapper
- `web/components/connection-status.tsx` - Connection indicator
- `web/hooks/use-websocket.ts` - WebSocket connection hook

**Modified files:**
- `web/components/session-view.tsx` - Add chat input, mode toggle
- `web/components/session-list.tsx` - Add new session button, active indicators

### API Design

**WebSocket Messages (Client → Server):**
```typescript
// Start/resume session
{ type: "session.start", sessionId?: string, projectPath?: string }

// Send user message
{ type: "message.send", content: string }

// Interrupt current operation
{ type: "session.interrupt" }

// Switch modes
{ type: "mode.switch", mode: "chat" | "terminal" }

// Close session
{ type: "session.close" }
```

**WebSocket Messages (Server → Client):**
```typescript
// Session started
{ type: "session.started", sessionId: string }

// Assistant message chunk (chat mode)
{ type: "assistant.chunk", content: ContentBlock[] }

// Terminal output (terminal mode)
{ type: "terminal.output", data: string }

// Session ended
{ type: "session.ended", reason: string }

// Error
{ type: "error", message: string }
```

## Tasks

### Phase 1: WebSocket Infrastructure
- [x] Add ws dependency, create WebSocket server
- [x] Implement connection management (multiple clients)
- [x] Add process-manager for spawning Claude CLI
- [x] Test basic message round-trip

### Phase 2: Chat Mode Integration
- [x] Create chat-input component
- [x] Implement use-websocket hook
- [x] Integrate with session-view
- [ ] Handle message streaming and rendering
- [ ] Add connection status indicator

### Phase 3: Session Management
- [ ] New session creation flow
- [ ] Session resume from viewer
- [ ] Active session indicators in list
- [ ] Graceful shutdown handling

### Phase 4: Terminal Mode
- [ ] Add node-pty, xterm.js dependencies
- [ ] Create terminal-view component
- [ ] Implement PTY-WebSocket bridge
- [ ] Add mode toggle UI

### Phase 5: Polish
- [ ] Error handling and recovery
- [ ] Reconnection logic
- [ ] Multiple tab support
- [ ] Performance optimization

## Verification Plan

1. **Unit tests**: Process manager, WebSocket message handling
2. **Integration tests**: Full message round-trip
3. **E2E tests with agent-browser**: Automate browser interactions
   ```bash
   # Example: Test chat input submission
   agent-browser open http://localhost:12000
   agent-browser snapshot -i
   agent-browser click @e1                    # Select a session
   agent-browser fill @e2 "hello world"       # Fill chat input
   agent-browser click @e3                    # Click send
   agent-browser wait --text "assistant"      # Wait for response

   # Example: Test multiple concurrent sessions
   agent-browser --session tab1 open http://localhost:12000
   agent-browser --session tab2 open http://localhost:12000
   # Interact with both in parallel
   ```
4. **Manual testing**:
   - Start new session from UI
   - Resume existing session
   - Send messages, receive responses
   - Interrupt running operation
   - Switch between chat/terminal modes
   - Multiple concurrent sessions in different tabs
   - Reconnect after network drop

## Files to Create/Modify

**Create:**
- `api/websocket.ts`
- `api/process-manager.ts`
- `web/components/chat-input.tsx`
- `web/components/terminal-view.tsx`
- `web/components/connection-status.tsx`
- `web/hooks/use-websocket.ts`

**Modify:**
- `api/index.ts`
- `api/server.ts`
- `web/components/session-view.tsx`
- `web/components/session-list.tsx`
- `package.json`

## Design Decisions

1. **Authentication**: None required - local-only access like current viewer
2. **Process cleanup**: PID file tracking - write active PIDs to `~/.claude-run/pids.json`, cleanup on restart
3. **Resource limits**: 5-10 max concurrent sessions with configurable limit
