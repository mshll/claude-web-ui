import { useState, useEffect, memo } from "react";
import { X } from "lucide-react";

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSession: (projectPath: string) => void;
}

interface Project {
  path: string;
  name: string;
}

const NewSessionModal = memo(function NewSessionModal(
  props: NewSessionModalProps
) {
  const { isOpen, onClose, onCreateSession } = props;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetch("/api/projects")
        .then((res) => res.json())
        .then((data: Project[]) => {
          setProjects(data);
          if (data.length > 0 && !selectedProject) {
            setSelectedProject(data[0].path);
          }
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    }
  }, [isOpen, selectedProject]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProject) {
      onCreateSession(selectedProject);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-zinc-900 rounded-lg border border-zinc-700 w-full max-w-md mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-medium text-zinc-200">New Session</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4">
          <label className="block mb-2">
            <span className="text-xs text-zinc-400 block mb-1.5">Project</span>
            {loading ? (
              <div className="h-9 flex items-center justify-center bg-zinc-800 rounded border border-zinc-700">
                <svg
                  className="w-4 h-4 text-zinc-600 animate-spin"
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
            ) : projects.length === 0 ? (
              <div className="h-9 flex items-center px-3 bg-zinc-800 rounded border border-zinc-700 text-xs text-zinc-500">
                No projects found
              </div>
            ) : (
              <select
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                className="w-full h-9 px-3 bg-zinc-800 rounded border border-zinc-700 text-sm text-zinc-200 focus:outline-none focus:border-cyan-600"
              >
                {projects.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          {selectedProject && (
            <p className="text-[10px] text-zinc-500 mb-4 break-all">
              {selectedProject}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedProject || loading}
              className="px-3 py-1.5 text-xs text-white bg-cyan-600 hover:bg-cyan-700 disabled:bg-zinc-700 disabled:text-zinc-500 rounded transition-colors"
            >
              Start Session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
});

export { NewSessionModal };
