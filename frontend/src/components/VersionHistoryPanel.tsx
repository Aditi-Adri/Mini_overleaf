import { useEffect, useState } from "react";
import { getVersionDiff, listVersions, saveVersion, type VersionDiffFile, type VersionEntry } from "../lib/api";

interface Props {
  projectId: string;
  editToken: string | null;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function VersionHistoryPanel({ projectId, editToken, onClose }: Props) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [diffFiles, setDiffFiles] = useState<VersionDiffFile[] | null>(null);
  const [diffLabel, setDiffLabel] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [saveLabel, setSaveLabel] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    setListError(null);
    try {
      setVersions(await listVersions(projectId));
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Only the project identity should re-trigger the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function runDiff(fromHash: string, toHash: string, label: string) {
    setDiffLoading(true);
    setDiffError(null);
    setDiffFiles(null);
    setDiffLabel(label);
    try {
      setDiffFiles(await getVersionDiff(projectId, fromHash, toHash));
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  }

  function toggleSelect(hash: string) {
    setSelected((prev) => {
      if (prev.includes(hash)) return prev.filter((h) => h !== hash);
      if (prev.length >= 2) return [prev[1], hash];
      return [...prev, hash];
    });
  }

  function compareSelected() {
    if (selected.length !== 2) return;
    // `versions` is newest-first, so a higher index is older — diff reads
    // naturally as "changes from the older pick to the newer pick"
    // regardless of the order the two were checked in.
    const [hashA, hashB] = selected;
    const indexA = versions.findIndex((v) => v.hash === hashA);
    const indexB = versions.findIndex((v) => v.hash === hashB);
    const [olderHash, newerHash] = indexA > indexB ? [hashA, hashB] : [hashB, hashA];
    void runDiff(olderHash, newerHash, "Comparing selected versions");
  }

  function viewChangesFor(index: number) {
    const version = versions[index];
    const previous = versions[index + 1];
    if (!previous) return;
    void runDiff(previous.hash, version.hash, `Changes at ${formatTimestamp(version.createdAt)}`);
  }

  async function handleSave() {
    if (!editToken) return;
    setSaving(true);
    try {
      await saveVersion(projectId, editToken, saveLabel.trim() || undefined);
      setSaveLabel("");
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="version-history-overlay" onClick={onClose}>
      <div className="version-history-panel" onClick={(e) => e.stopPropagation()}>
        <header className="version-history-header">
          <h2>Version history</h2>
          <button type="button" className="version-history-close" onClick={onClose} aria-label="Close version history">
            ×
          </button>
        </header>

        {editToken && (
          <div className="version-history-save">
            <input
              type="text"
              placeholder="Label (optional)"
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
              disabled={saving}
            />
            <button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : "Save version now"}
            </button>
          </div>
        )}

        <div className="version-history-body">
          <div className="version-history-list">
            {loading && <p className="version-history-status">Loading…</p>}
            {listError && <p className="version-history-status version-history-status--error">{listError}</p>}
            {!loading && !listError && versions.length === 0 && (
              <p className="version-history-status">No snapshots yet — one is taken automatically on every successful compile.</p>
            )}
            {versions.map((version, index) => (
              <div key={version.hash} className="version-history-item">
                <input
                  type="checkbox"
                  checked={selected.includes(version.hash)}
                  onChange={() => toggleSelect(version.hash)}
                  aria-label={`Select version from ${formatTimestamp(version.createdAt)}`}
                />
                <div className="version-history-item-details">
                  <span className={`version-history-badge version-history-badge--${version.trigger}`}>
                    {version.trigger === "manual" ? "Manual save" : "Compile"}
                  </span>
                  <span className="version-history-timestamp">{formatTimestamp(version.createdAt)}</span>
                  {version.trigger === "manual" && version.message !== "Manual save" && (
                    <span className="version-history-message">{version.message.replace(/^Manual save: /, "")}</span>
                  )}
                </div>
                <button type="button" className="version-history-view-link" onClick={() => viewChangesFor(index)} disabled={index === versions.length - 1}>
                  View changes
                </button>
              </div>
            ))}
          </div>

          <div className="version-history-diff">
            <div className="version-history-diff-toolbar">
              <button type="button" onClick={compareSelected} disabled={selected.length !== 2}>
                Compare selected ({selected.length}/2)
              </button>
              {diffLabel && <span className="version-history-diff-label">{diffLabel}</span>}
            </div>
            {diffLoading && <p className="version-history-status">Loading diff…</p>}
            {diffError && <p className="version-history-status version-history-status--error">{diffError}</p>}
            {!diffLoading && !diffError && diffFiles && diffFiles.length === 0 && (
              <p className="version-history-status">No differences between these versions.</p>
            )}
            {!diffLoading &&
              diffFiles?.map((file) => (
                <div key={file.path} className="version-history-diff-file">
                  <div className="version-history-diff-file-header">
                    <span className={`version-history-badge version-history-badge--${file.status}`}>{file.status}</span>
                    <span className="version-history-diff-file-path">{file.path}</span>
                  </div>
                  {file.status === "binary" ? <p className="version-history-status">Binary file changed.</p> : <DiffLines diffText={file.diffText} />}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffLines({ diffText }: { diffText: string }) {
  const lines = diffText.split("\n");
  return (
    <pre className="version-history-diff-lines">
      {lines.map((line, i) => {
        let cls = "diff-line-context";
        if (line.startsWith("@@")) cls = "diff-line-hunk";
        else if (line.startsWith("+")) cls = "diff-line-add";
        else if (line.startsWith("-")) cls = "diff-line-del";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
