import { watch, type FSWatcher } from "chokidar";
import { basename, join } from "path";

type HistoryChangeCallback = () => void;
type SessionChangeCallback = (sessionId: string, filePath: string) => void;

let watcher: FSWatcher | null = null;
let claudeDir = "";
const debounceTimers = new Map<string, NodeJS.Timeout>();
const debounceMs = 20;

const historyChangeListeners = new Set<HistoryChangeCallback>();
const sessionChangeListeners = new Set<SessionChangeCallback>();

export function initWatcher(dir: string): void {
  claudeDir = dir;
}

function emitChange(filePath: string): void {
  if (filePath.endsWith("history.jsonl")) {
    for (const callback of historyChangeListeners) {
      callback();
    }
  } else if (filePath.endsWith(".jsonl")) {
    const sessionId = basename(filePath, ".jsonl");
    for (const callback of sessionChangeListeners) {
      callback(sessionId, filePath);
    }
  }
}

function handleChange(path: string): void {
  const existing = debounceTimers.get(path);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(path);
    emitChange(path);
  }, debounceMs);

  debounceTimers.set(path, timer);
}

export function startWatcher(): void {
  if (watcher) {
    return;
  }

  const historyPath = join(claudeDir, "history.jsonl");
  const projectsDir = join(claudeDir, "projects");
  const usePolling = process.env.CLAUDE_RUN_USE_POLLING === "1";

  watcher = watch([historyPath, projectsDir], {
    persistent: true,
    ignoreInitial: true,
    usePolling,
    ...(usePolling && { interval: 100 }),
    depth: 2,
  });

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export function onHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.add(callback);
}

export function offHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.delete(callback);
}

export function onSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.add(callback);
}

export function offSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.delete(callback);
}
