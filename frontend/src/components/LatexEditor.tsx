import { useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { LATEX_LANGUAGE_ID, registerLatexLanguage } from "../lib/latexLanguage";
import { renderAwarenessStyles } from "../lib/awarenessStyles";
import { rawFileUrl, type CompileErrorEntry } from "../lib/api";
import { CONTENT_KEY, collabServerUrl } from "../lib/room";
import type { LocalUser } from "../lib/identity";
import { applyErrorMarkers, errorsForFile } from "../lib/compileErrors";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Peer {
  clientId: number;
  name: string;
  color: string;
}

interface Props {
  projectId: string;
  fileId: string;
  filePath: string;
  /** Read-only viewers (no edit token) never open a WebSocket at all — see ReadOnlyFile below. */
  editToken: string | null;
  localUser: LocalUser;
  onContentChange: (text: string) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  /** Optional — project-wide presence (see useProjectPresence) already covers "who's here"; this is only for callers that want the raw per-file cursor list too. */
  onPeersChange?: (peers: Peer[]) => void;
  /** Whole-project compile errors — filtered to this file and underlined the way a linter would. */
  compileErrors: CompileErrorEntry[];
}

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 14,
  lineNumbers: "on" as const,
  wordWrap: "on" as const,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  padding: { top: 12 },
};

export function LatexEditor(props: Props) {
  const fileErrors = errorsForFile(props.compileErrors, props.filePath);
  if (!props.editToken) {
    return (
      <ReadOnlyFile projectId={props.projectId} fileId={props.fileId} onContentChange={props.onContentChange} compileErrors={fileErrors} />
    );
  }
  return <CollaborativeEditor {...props} editToken={props.editToken} compileErrors={fileErrors} />;
}

/**
 * One Monaco editor instance is shared across every file in the project —
 * switching files swaps out its text *model* rather than remounting the
 * whole editor (matches how e.g. VS Code itself switches tabs). Each model
 * gets a fresh Yjs doc/provider/binding for that file's collaboration room,
 * torn down and recreated whenever `fileId` changes.
 */
function CollaborativeEditor({
  fileId,
  editToken,
  localUser,
  onContentChange,
  onStatusChange,
  onPeersChange,
  compileErrors,
}: Props & { editToken: string }) {
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const modelRef = useRef<MonacoEditorNS.ITextModel | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  // Effect below fires per fileId change — these refs let it always call the
  // *latest* callback props without needing them as dependencies (which
  // would mean tearing down and reconnecting the WebSocket on every parent
  // re-render, not just on an actual file switch).
  const onContentChangeRef = useRef(onContentChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onPeersChangeRef = useRef(onPeersChange);
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onStatusChangeRef.current = onStatusChange;
    onPeersChangeRef.current = onPeersChange;
  });

  const handleBeforeMount: BeforeMount = (monaco) => {
    registerLatexLanguage(monaco);
  };

  const handleMount: OnMount = (editor, monaco) => {
    editor.focus();
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReady(true);
  };

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    onStatusChangeRef.current("connecting");
    onPeersChangeRef.current?.([]);

    const ydoc = new Y.Doc();
    // Browsers can't set custom headers on a WS handshake, so the edit
    // token travels as a query param — validated server-side before the
    // upgrade is even accepted (see backend/src/wsAuth.ts).
    const provider = new WebsocketProvider(collabServerUrl(), fileId, ydoc, { params: { token: editToken } });
    const ytext = ydoc.getText(CONTENT_KEY);
    provider.awareness.setLocalStateField("user", localUser);

    const model = monaco.editor.createModel("", LATEX_LANGUAGE_ID);
    editor.setModel(model);
    modelRef.current = model;
    const binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness);

    const reportContent = () => onContentChangeRef.current(ytext.toString());
    ytext.observe(reportContent);
    reportContent();

    const reportStatus = (event: { status: ConnectionStatus }) => onStatusChangeRef.current(event.status);
    provider.on("status", reportStatus);

    const reportPeers = () => {
      const states = provider.awareness.getStates();
      renderAwarenessStyles(states, provider.awareness.clientID);

      const peers: Peer[] = [];
      states.forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return;
        const user = (state as { user?: { name: string; color: string } }).user;
        if (user) peers.push({ clientId, name: user.name, color: user.color });
      });
      onPeersChangeRef.current?.(peers);
    };
    provider.awareness.on("change", reportPeers);
    reportPeers();

    return () => {
      ytext.unobserve(reportContent);
      provider.off("status", reportStatus);
      provider.awareness.off("change", reportPeers);
      binding.destroy();
      provider.destroy();
      ydoc.destroy();
      model.dispose();
      if (modelRef.current === model) modelRef.current = null;
    };
  }, [fileId, editToken, editorReady, localUser]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = modelRef.current;
    if (!monaco || !model) return;
    applyErrorMarkers(monaco, model, compileErrors);
  }, [compileErrors, fileId]);

  return <Editor defaultLanguage={LATEX_LANGUAGE_ID} beforeMount={handleBeforeMount} onMount={handleMount} theme="vs-dark" options={EDITOR_OPTIONS} />;
}

/**
 * No edit token means no WebSocket at all (see wsAuth.ts — the server
 * rejects the upgrade outright), so a read-only visitor gets a REST-fetched
 * snapshot instead of a live collaborative session: not real-time, but a
 * genuinely useful "here's what this project currently looks like" view,
 * refetched whenever the selected file changes.
 */
function ReadOnlyFile({
  projectId,
  fileId,
  onContentChange,
  compileErrors,
}: {
  projectId: string;
  fileId: string;
  onContentChange: (text: string) => void;
  compileErrors: CompileErrorEntry[];
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);

    fetch(rawFileUrl(projectId, fileId))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        onContentChange(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, fileId, onContentChange]);

  const handleBeforeMount: BeforeMount = (monaco) => {
    registerLatexLanguage(monaco);
  };
  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    applyErrorMarkers(monaco, model, compileErrors);
  }, [compileErrors, content]);

  if (error) {
    return <div className="editor-readonly-error">Couldn't load this file: {error}</div>;
  }

  return (
    <Editor
      language={LATEX_LANGUAGE_ID}
      value={content ?? ""}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      theme="vs-dark"
      options={{ ...EDITOR_OPTIONS, readOnly: true }}
    />
  );
}
