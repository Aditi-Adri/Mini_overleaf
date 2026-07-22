import { useEffect, useMemo, useState } from "react";
import { CompileErrorPanel } from "./components/CompileErrorPanel";
import { FileTree } from "./components/FileTree";
import { LatexEditor, type ConnectionStatus } from "./components/LatexEditor";
import { PdfViewer } from "./components/PdfViewer";
import { PresenceBar } from "./components/PresenceBar";
import { StatusBar } from "./components/StatusBar";
import { VersionHistoryPanel } from "./components/VersionHistoryPanel";
import { useProjectCompiler } from "./hooks/useLatexCompiler";
import { useProjectPresence } from "./hooks/useProjectPresence";
import { createProject, getProject, type Project, type ProjectFile } from "./lib/api";
import { getLocalUser } from "./lib/identity";
import {
  consumeTokenFromUrl,
  editLinkFor,
  getProjectIdFromUrl,
  getStoredEditToken,
  setProjectIdInUrl,
  storeEditToken,
  viewLinkFor,
} from "./lib/room";

function App() {
  const [localUser] = useState(getLocalUser);
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [source, setSource] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [showHistory, setShowHistory] = useState(false);

  // Resolve the project (and this browser's edit access, if any) from the
  // URL, or create a new one, once on mount. A project can't just be minted
  // locally as a random id the way phase 2's single document could — it has
  // to actually exist (with seeded files, and an edit_token) in Postgres —
  // so this is a real server round trip. See lib/room.ts for the token flow.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const existingId = getProjectIdFromUrl();
        const urlToken = consumeTokenFromUrl();

        let data: { project: Project; files: ProjectFile[] } | null = null;
        let token: string | null = null;

        if (existingId) {
          data = await getProject(existingId);
          if (data) {
            if (urlToken) storeEditToken(existingId, urlToken);
            token = urlToken ?? getStoredEditToken(existingId);
          }
        }

        if (!data) {
          const created = await createProject();
          data = { project: created.project, files: created.files };
          token = created.editToken;
          storeEditToken(created.project.id, created.editToken);
          setProjectIdInUrl(created.project.id);
        }

        if (cancelled) return;
        setProject(data.project);
        setFiles(data.files);
        setEditToken(token);
        setActiveFileId(data.project.mainFileId ?? data.files.find((f) => f.kind === "text")?.id ?? null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const compiler = useProjectCompiler(project?.id ?? null, source);
  const activeFilePath = files.find((f) => f.id === activeFileId)?.path ?? null;
  const projectPeers = useProjectPresence(project?.id ?? null, editToken, localUser, activeFilePath);

  const links = useMemo(() => {
    if (!project) return { edit: "", view: "" };
    return { edit: editToken ? editLinkFor(project.id, editToken) : "", view: viewLinkFor(project.id) };
  }, [project, editToken]);

  if (loadError) {
    return <div className="app-status-screen app-status-screen--error">Couldn't load this project: {loadError}</div>;
  }
  if (!project || !activeFileId) {
    return <div className="app-status-screen">Loading project…</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>mini-overleaf</h1>
        <div className="app-header-right">
          <PresenceBar
            localUser={localUser}
            peers={projectPeers}
            connectionStatus={connectionStatus}
            isEditor={editToken !== null}
            editLink={links.edit}
            viewLink={links.view}
          />
          <button type="button" className="share-button share-button--secondary" onClick={() => setShowHistory(true)}>
            History
          </button>
          <StatusBar {...compiler} />
        </div>
      </header>
      <main className="app-body">
        <FileTree
          projectId={project.id}
          editToken={editToken}
          files={files}
          activeFileId={activeFileId}
          mainFileId={project.mainFileId}
          onSelectFile={setActiveFileId}
          onFilesChange={setFiles}
          onMainFileChange={(fileId) => setProject((p) => (p ? { ...p, mainFileId: fileId } : p))}
        />
        <div className="app-split">
          <section className="pane pane-editor">
            <LatexEditor
              projectId={project.id}
              fileId={activeFileId}
              filePath={activeFilePath ?? ""}
              editToken={editToken}
              localUser={localUser}
              onContentChange={setSource}
              onStatusChange={setConnectionStatus}
              compileErrors={compiler.errors}
            />
          </section>
          <section className="pane pane-preview">
            {compiler.status === "error" && compiler.error ? (
              <CompileErrorPanel error={compiler.error} errors={compiler.errors} />
            ) : (
              <PdfViewer data={compiler.pdfData} />
            )}
          </section>
        </div>
      </main>
      {showHistory && <VersionHistoryPanel projectId={project.id} editToken={editToken} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

export default App;
