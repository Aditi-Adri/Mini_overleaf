import { useEffect, useRef } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { MonacoBinding } from "y-monaco";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { LATEX_LANGUAGE_ID, registerLatexLanguage } from "../lib/latexLanguage";
import { renderAwarenessStyles } from "../lib/awarenessStyles";
import { CONTENT_KEY, collabServerUrl } from "../lib/room";
import type { LocalUser } from "../lib/identity";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Peer {
  clientId: number;
  name: string;
  color: string;
}

interface Props {
  docId: string;
  localUser: LocalUser;
  onContentChange: (text: string) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  onPeersChange: (peers: Peer[]) => void;
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

export function LatexEditor({ docId, localUser, onContentChange, onStatusChange, onPeersChange }: Props) {
  // onMount fires exactly once per editor instance — these refs let it always
  // call the *latest* callback props without needing to depend on them
  // (which would mean tearing down and reconnecting the WebSocket on every
  // parent re-render).
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

  const handleMount: OnMount = (editor) => {
    editor.focus();

    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(collabServerUrl(), docId, ydoc);
    const ytext = ydoc.getText(CONTENT_KEY);

    provider.awareness.setLocalStateField("user", localUser);

    const model = editor.getModel();
    const binding = model ? new MonacoBinding(ytext, model, new Set([editor]), provider.awareness) : null;

    const reportContent = () => onContentChangeRef.current(ytext.toString());
    ytext.observe(reportContent);
    reportContent();

    onStatusChangeRef.current("connecting");
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
      onPeersChangeRef.current(peers);
    };
    provider.awareness.on("change", reportPeers);
    reportPeers();

    editor.onDidDispose(() => {
      ytext.unobserve(reportContent);
      provider.off("status", reportStatus);
      provider.awareness.off("change", reportPeers);
      binding?.destroy();
      provider.destroy();
      ydoc.destroy();
    });
  };

  return (
    <Editor
      language={LATEX_LANGUAGE_ID}
      defaultValue=""
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      theme="vs-dark"
      options={EDITOR_OPTIONS}
    />
  );
}
