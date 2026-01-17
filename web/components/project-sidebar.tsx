import { useState, useMemo, memo } from "react";
import { ChevronRight, ChevronDown, Plus } from "lucide-react";
import type { Session } from "@claude-web-ui/api";
import { formatTime } from "../utils";

interface ProjectSidebarProps {
  sessions: Session[];
  selectedSession: string | null;
  onSelectSession: (sessionId: string) => void;
  expandedProjects: Set<string>;
  onToggleProject: (project: string) => void;
  loading?: boolean;
  activeSessions?: Set<string>;
  onNewSession?: () => void;
}

interface ProjectGroup {
  project: string;
  name: string;
  sessions: Session[];
  latestTimestamp: number;
}

function groupSessionsByProject(sessions: Session[]): ProjectGroup[] {
  const groupMap = new Map<string, ProjectGroup>();

  for (const session of sessions) {
    const existing = groupMap.get(session.project);
    if (existing) {
      existing.sessions.push(session);
      if (session.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = session.timestamp;
      }
    } else {
      groupMap.set(session.project, {
        project: session.project,
        name: session.projectName,
        sessions: [session],
        latestTimestamp: session.timestamp,
      });
    }
  }

  return Array.from(groupMap.values()).sort(
    (a, b) => b.latestTimestamp - a.latestTimestamp
  );
}

const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  const {
    sessions,
    selectedSession,
    onSelectSession,
    expandedProjects,
    onToggleProject,
    loading,
    activeSessions = new Set(),
    onNewSession,
  } = props;
  const [search, setSearch] = useState("");

  const filteredSessions = useMemo(() => {
    if (!search.trim()) {
      return sessions;
    }
    const query = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.display.toLowerCase().includes(query) ||
        s.projectName.toLowerCase().includes(query)
    );
  }, [sessions, search]);

  const groups = useMemo(
    () => groupSessionsByProject(filteredSessions),
    [filteredSessions]
  );

  return (
    <div className="h-full overflow-hidden bg-zinc-950 flex flex-col">
      <div className="h-10 px-3 flex items-center border-b border-zinc-800/60">
        <div className="flex items-center gap-2 text-zinc-500 flex-1">
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
        {onNewSession && (
          <button
            onClick={onNewSession}
            className="p-1.5 hover:bg-zinc-800 rounded transition-colors ml-2"
            title="New session"
          >
            <Plus className="w-4 h-4 text-zinc-400" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <svg
              className="w-5 h-5 text-zinc-600 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-xs text-zinc-600">
            {search ? "No sessions match" : "No sessions found"}
          </p>
        ) : (
          <div>
            {groups.map((group) => {
              const isExpanded = expandedProjects.has(group.project);
              return (
                <div key={group.project}>
                  <button
                    onClick={() => onToggleProject(group.project)}
                    className="w-full h-10 px-3 text-left flex items-center gap-2 hover:bg-zinc-900/60 border-b border-zinc-800/40"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                    )}
                    <span className="text-xs text-zinc-300 font-medium truncate flex-1">
                      {group.name}
                    </span>
                    <span className="text-[10px] text-zinc-600 flex-shrink-0">
                      {group.sessions.length}
                    </span>
                  </button>
                  {isExpanded && (
                    <div>
                      {group.sessions.map((session) => {
                        const isActive = activeSessions.has(session.id);
                        return (
                          <button
                            key={session.id}
                            onClick={() => onSelectSession(session.id)}
                            className={`w-full pl-8 pr-3 py-2.5 text-left overflow-hidden border-b border-zinc-800/40 ${
                              selectedSession === session.id
                                ? "bg-cyan-700/30"
                                : "hover:bg-zinc-900/60"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-0.5">
                              <div className="flex items-center gap-1.5">
                                {isActive && (
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"
                                    title="Active session"
                                  />
                                )}
                                <span className="text-[10px] text-zinc-600">
                                  {formatTime(session.timestamp)}
                                </span>
                              </div>
                            </div>
                            <p className="text-[12px] text-zinc-300 leading-snug line-clamp-2 break-words">
                              {session.display}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-zinc-800/60">
        <div className="text-[10px] text-zinc-600 text-center">
          {groups.length} project{groups.length !== 1 ? "s" : ""} &middot;{" "}
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
});

export { ProjectSidebar };
