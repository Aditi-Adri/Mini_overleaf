import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Props {
  data: Uint8Array | null;
}

export function PdfViewer({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!data || !container) return;

    let cancelled = false;
    // pdf.js frees the worker/document resources via the loading task, not
    // the resolved PDFDocumentProxy, so that's what cleanup needs to hold.
    const loadingTask = pdfjsLib.getDocument({ data: data.slice() });
    setRenderError(null);

    async function render() {
      if (!container) return;
      container.replaceChildren();
      const outputScale = window.devicePixelRatio || 1;

      try {
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          if (cancelled) return;

          const cssWidth = Math.max(container.clientWidth - 32, 200);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const cssScale = cssWidth / unscaledViewport.width;
          const viewport = page.getViewport({ scale: cssScale * outputScale });

          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / outputScale)}px`;
          canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;
          container.appendChild(canvas);

          await page.render({ canvas, viewport }).promise;
        }
      } catch (err) {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : String(err));
      }
    }

    render();
    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [data]);

  if (!data) {
    return (
      <div className="pdf-empty">
        <p>Your compiled PDF will appear here.</p>
        <p className="pdf-empty-hint">Start typing in the editor — it compiles automatically.</p>
      </div>
    );
  }

  if (renderError) {
    return <div className="pdf-empty pdf-empty-error">Failed to render PDF: {renderError}</div>;
  }

  return (
    <div className="pdf-scroll">
      <div ref={containerRef} className="pdf-pages" />
      {pageCount > 0 && (
        <div className="pdf-page-count">
          {pageCount} page{pageCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
