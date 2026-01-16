import { useState, useEffect, useCallback } from "react";

export function useActiveSessions(pollInterval = 5000): Set<string> {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(
    () => new Set()
  );

  const fetchActiveSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions/active");
      if (response.ok) {
        const data: string[] = await response.json();
        setActiveSessions(new Set(data));
      }
    } catch {
      // Silently ignore fetch errors
    }
  }, []);

  useEffect(() => {
    fetchActiveSessions();
    const interval = setInterval(fetchActiveSessions, pollInterval);
    return () => clearInterval(interval);
  }, [fetchActiveSessions, pollInterval]);

  return activeSessions;
}
