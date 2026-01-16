import { useState, useCallback, useMemo } from "react";
import type { Session } from "@claude-run/api";
import { PanelLeft, Copy, Check } from "lucide-react";
import { formatTime } from "./utils";
import { ProjectSidebar } from "./components/project-sidebar";
import SessionView from "./components/session-view";
import { useEventSource } from "./hooks/use-event-source";

interface SessionHeaderProps {
  session: Session;
  copied: boolean;
  onCopyResumeCommand: (sessionId: string, projectPath: string) => void;
}

function SessionHeader(props: SessionHeaderProps) {
  const { session, copied, onCopyResumeCommand } = props;

  return (
    <>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-sm text-zinc-300 truncate max-w-xs">
          {session.display}
        </span>
        <span className="text-xs text-zinc-600 shrink-0">
          {session.projectName}
        </span>
        <span className="text-xs text-zinc-600 shrink-0">
          {formatTime(session.timestamp)}
        </span>
      </div>
      <button
        onClick={() => onCopyResumeCommand(session.id, session.project)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer shrink-0"
        title="Copy resume command to clipboard"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-green-500" />
            <span className="text-green-500">Copied!</span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            <span>Copy Resume Command</span>
          </>
        )}
      </button>
    </>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set()
  );

  const handleCopyResumeCommand = useCallback(
    (sessionId: string, projectPath: string) => {
      const command = `cd ${projectPath} && claude --resume ${sessionId}`;
      navigator.clipboard.writeText(command).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    },
    [],
  );

  const selectedSessionData = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    return sessions.find((s) => s.id === selectedSession) || null;
  }, [sessions, selectedSession]);

  const handleToggleProject = useCallback((project: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  }, []);

  const handleSessionsFull = useCallback((event: MessageEvent) => {
    const data: Session[] = JSON.parse(event.data);
    setSessions(data);
    setLoading(false);
  }, []);

  const handleSessionsUpdate = useCallback((event: MessageEvent) => {
    const updates: Session[] = JSON.parse(event.data);
    setSessions((prev) => {
      const sessionMap = new Map(prev.map((s) => [s.id, s]));
      for (const update of updates) {
        sessionMap.set(update.id, update);
      }
      return Array.from(sessionMap.values()).sort(
        (a, b) => b.timestamp - a.timestamp,
      );
    });
  }, []);

  const handleSessionsError = useCallback(() => {
    setLoading(false);
  }, []);

  useEventSource("/api/sessions/stream", {
    events: [
      { eventName: "sessions", onMessage: handleSessionsFull },
      { eventName: "sessionsUpdate", onMessage: handleSessionsUpdate },
    ],
    onError: handleSessionsError,
  });

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
  }, []);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {!sidebarCollapsed && (
        <aside className="w-80 border-r border-zinc-800/60 flex flex-col bg-zinc-950">
          <ProjectSidebar
            sessions={sessions}
            selectedSession={selectedSession}
            onSelectSession={handleSelectSession}
            expandedProjects={expandedProjects}
            onToggleProject={handleToggleProject}
            loading={loading}
          />
        </aside>
      )}

      <main className="flex-1 overflow-hidden bg-zinc-950 flex flex-col">
        <div className="h-10 border-b border-zinc-800/60 flex items-center px-4 gap-4">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-1.5 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
          >
            <PanelLeft className="w-4 h-4 text-zinc-400" />
          </button>
          {selectedSessionData && (
            <SessionHeader
              session={selectedSessionData}
              copied={copied}
              onCopyResumeCommand={handleCopyResumeCommand}
            />
          )}
        </div>
        <div className="flex-1 overflow-hidden">
          {selectedSession ? (
            <SessionView
              sessionId={selectedSession}
              projectPath={selectedSessionData?.project}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <div className="text-center">
                <div className="text-base mb-2 text-zinc-500">
                  Select a session
                </div>
                <div className="text-sm text-zinc-600">
                  Choose a session from the list to view the conversation
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
