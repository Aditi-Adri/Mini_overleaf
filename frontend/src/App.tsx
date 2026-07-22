import { useState } from "react";
import { LatexEditor } from "./components/LatexEditor";
import { PdfViewer } from "./components/PdfViewer";
import { StatusBar } from "./components/StatusBar";
import { useLatexCompiler } from "./hooks/useLatexCompiler";
import { DEFAULT_DOCUMENT } from "./lib/defaultDocument";

const SOURCE_STORAGE_KEY = "mini-overleaf:source";

function loadInitialSource(): string {
  return localStorage.getItem(SOURCE_STORAGE_KEY) ?? DEFAULT_DOCUMENT;
}

function App() {
  const [source, setSource] = useState(loadInitialSource);
  const compiler = useLatexCompiler(source);

  function handleChange(next: string) {
    setSource(next);
    localStorage.setItem(SOURCE_STORAGE_KEY, next);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>mini-overleaf</h1>
        <StatusBar {...compiler} />
      </header>
      <main className="app-split">
        <section className="pane pane-editor">
          <LatexEditor value={source} onChange={handleChange} />
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
