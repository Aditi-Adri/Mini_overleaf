import { useState } from "react";
import { LatexEditor, type ConnectionStatus, type Peer } from "./components/LatexEditor";
import { PdfViewer } from "./components/PdfViewer";
import { PresenceBar } from "./components/PresenceBar";
import { StatusBar } from "./components/StatusBar";
import { useLatexCompiler } from "./hooks/useLatexCompiler";
import { getLocalUser } from "./lib/identity";
import { getOrCreateDocId } from "./lib/room";

function App() {
  const [docId] = useState(getOrCreateDocId);
  const [localUser] = useState(getLocalUser);
  const [source, setSource] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  const compiler = useLatexCompiler(source, docId);

  return (
    <div className="app">
      <header className="app-header">
        <h1>mini-overleaf</h1>
        <div className="app-header-right">
          <PresenceBar localUser={localUser} peers={peers} connectionStatus={connectionStatus} />
          <StatusBar {...compiler} />
        </div>
      </header>
      <main className="app-split">
        <section className="pane pane-editor">
          <LatexEditor
            docId={docId}
            localUser={localUser}
            onContentChange={setSource}
            onStatusChange={setConnectionStatus}
            onPeersChange={setPeers}
          />
        </section>
        <section className="pane pane-preview">
          {compiler.status === "error" && compiler.error ? (
            <pre className="compile-error">{compiler.error}</pre>
          ) : (
            <PdfViewer data={compiler.pdfData} />
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
