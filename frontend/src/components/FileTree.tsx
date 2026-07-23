import { useMemo, useRef, useState } from "react";
import { createTextFile, deleteFile, renameFile, setMainFile, uploadFile, type ProjectFile } from "../lib/api";
import { isZipFile, runZipImportFlow } from "../lib/zipImportFlow";

interface Props {
  projectId: string;
  /** null means read-only: no create/upload/rename/delete/set-main controls, browsing only. */
  editToken: string | null;
  files: ProjectFile[];
  activeFileId: string | null;
  mainFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onFilesChange: (files: ProjectFile[]) => void;
  onMainFileChange: (fileId: string) => void;
}

interface TreeNode {
  name: string;
  fullPath: string;
  file?: ProjectFile;
  children: Map<string, TreeNode>;
}

function buildTree(files: ProjectFile[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map() };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/");
    let node = root;
    let pathSoFar = "";
    segments.forEach((segment, i) => {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, fullPath: pathSoFar, children: new Map() };
        node.children.set(segment, child);
      }
      if (i === segments.length - 1) child.file = file;
      node = child;
    });
  }
  return root;
}

function iconFor(file: ProjectFile): string {
  if (file.kind === "binary") return file.contentType?.startsWith("image/") ? "🖼" : "📎";
  if (file.path.endsWith(".bib")) return "📚";
  return "📄";
}

export function FileTree({ projectId, editToken, files, activeFileId, mainFileId, onSelectFile, onFilesChange, onMainFileChange }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tree = useMemo(() => buildTree(files), [files]);
  const canEdit = editToken !== null;

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleNewFile() {
    if (!editToken) return;
    const path = window.prompt("New file path (e.g. sections/chapter2.tex):");
    if (!path) return;
    void withBusy(async () => {
      const result = await createTextFile(projectId, path.trim(), editToken);
      onFilesChange(result.files);
      onSelectFile(result.file.id);
    });
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked || !editToken) return;

    // A .zip here almost never means "attach this archive as an opaque
    // binary file" — it means the user wants its *contents* in the project,
    // which this single-file upload can't do. Redirect to the real import
    // flow (a new project, since extracting into the current one would mean
    // silently overwriting/merging unrelated files) instead of quietly
    // storing an unopened archive nobody can use.
    if (isZipFile(picked)) {
      void runZipImportFlow(picked, setBusy);
      return;
    }

    const suggestedPath = picked.type.startsWith("image/") ? `images/${picked.name}` : picked.name;
    const path = window.prompt("Upload as path:", suggestedPath);
    if (!path) return;
    void withBusy(async () => {
      const result = await uploadFile(projectId, path.trim(), picked, editToken);
      onFilesChange(result.files);
      onSelectFile(result.file.id);
    });
  }

  function handleRename(file: ProjectFile) {
    if (!editToken) return;
    const nextPath = window.prompt("Rename to:", file.path);
    if (!nextPath || nextPath === file.path) return;
    void withBusy(async () => {
      const result = await renameFile(projectId, file.id, nextPath.trim(), editToken);
      onFilesChange(result.files);
    });
  }

  function handleDelete(file: ProjectFile) {
    if (!editToken) return;
    if (!window.confirm(`Delete "${file.path}"? This can't be undone.`)) return;
    void withBusy(async () => {
      const result = await deleteFile(projectId, file.id, editToken);
      onFilesChange(result.files);
      if (activeFileId === file.id) {
        const next = result.files.find((f) => f.kind === "text");
        if (next) onSelectFile(next.id);
      }
    });
  }

  function handleSetMain(file: ProjectFile) {
    if (!editToken) return;
    void withBusy(async () => {
      await setMainFile(projectId, file.id, editToken);
      onMainFileChange(file.id);
    });
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    const entries = [...node.children.values()].sort((a, b) => {
      const aIsFolder = a.children.size > 0 && !a.file;
      const bIsFolder = b.children.size > 0 && !b.file;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries.map((entry) => {
      const isFolder = entry.children.size > 0 && !entry.file;
      if (isFolder) {
        const isCollapsed = collapsed.has(entry.fullPath);
        return (
          <div key={entry.fullPath}>
            <button
              type="button"
              className="file-tree-row file-tree-folder"
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
              onClick={() => toggleFolder(entry.fullPath)}
            >
              <span className="file-tree-caret">{isCollapsed ? "▸" : "▾"}</span>
              {entry.name}/
            </button>
            {!isCollapsed && renderNode(entry, depth + 1)}
          </div>
        );
      }

      const file = entry.file!;
      const isActive = file.id === activeFileId;
      const isMain = file.id === mainFileId;
      return (
        <div
          key={file.id}
          className={`file-tree-row file-tree-file${isActive ? " file-tree-file--active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <button type="button" className="file-tree-file-button" onClick={() => file.kind === "text" && onSelectFile(file.id)} disabled={file.kind !== "text"}>
            <span className="file-tree-icon">{iconFor(file)}</span>
            {entry.name}
            {isMain && (
              <span className="file-tree-main-badge" title="Main file (compiled)">
                ★
              </span>
            )}
          </button>
          {canEdit && (
            <span className="file-tree-actions">
              {file.kind === "text" && !isMain && (
                <button type="button" title="Set as main file" onClick={() => handleSetMain(file)}>
                  ★
                </button>
              )}
              <button type="button" title="Rename" onClick={() => handleRename(file)}>
                ✎
              </button>
              <button type="button" title="Delete" onClick={() => handleDelete(file)}>
                ✕
              </button>
            </span>
          )}
        </div>
      );
    });
  }

  return (
    <div className="file-tree">
      {canEdit ? (
        <div className="file-tree-toolbar">
          <button type="button" onClick={handleNewFile} disabled={busy}>
            + File
          </button>
          <button type="button" onClick={handleUploadClick} disabled={busy}>
            ↑ Upload
          </button>
          <input ref={fileInputRef} type="file" hidden onChange={handleFileInputChange} />
        </div>
      ) : (
        <div className="file-tree-readonly-banner">Read-only</div>
      )}
      {error && <div className="file-tree-error">{error}</div>}
      <div className="file-tree-list">{renderNode(tree, 0)}</div>
    </div>
  );
}
