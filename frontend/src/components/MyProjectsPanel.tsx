import { useEffect, useState } from "react";
import { listSavedProjects, unsaveProject, type SavedProject } from "../lib/auth";
import { editLinkFor, viewLinkFor } from "../lib/room";

interface Props {
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function MyProjectsPanel({ onClose }: Props) {
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listSavedProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleRemove(projectId: string) {
    try {
      await unsaveProject(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="version-history-overlay" onClick={onClose}>
      <div className="version-history-panel my-projects-panel" onClick={(e) => e.stopPropagation()}>
        <header className="version-history-header">
          <h2>My Projects</h2>
          <button type="button" className="version-history-close" onClick={onClose} aria-label="Close my projects">
            ×
          </button>
        </header>

        <div className="my-projects-body">
          {loading && <p className="version-history-status">Loading…</p>}
          {error && <p className="version-history-status version-history-status--error">{error}</p>}
          {!loading && !error && projects.length === 0 && (
            <p className="version-history-status">No saved projects yet — open a project and click "Save" to add it here.</p>
          )}
          {projects.map((project) => (
            <div key={project.id} className="my-projects-item">
              <div className="my-projects-item-details">
                <span className="my-projects-name">{project.name}</span>
                <span className="version-history-timestamp">Saved {formatTimestamp(project.savedAt)}</span>
              </div>
              <span className={`version-history-badge ${project.canEdit ? "version-history-badge--manual" : ""}`}>
                {project.canEdit ? "Editable" : "View only"}
              </span>
              <a
                className="share-button share-button--secondary"
                href={project.canEdit && project.editToken ? editLinkFor(project.id, project.editToken) : viewLinkFor(project.id)}
              >
                Open
              </a>
              <button type="button" className="version-history-view-link" onClick={() => void handleRemove(project.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
