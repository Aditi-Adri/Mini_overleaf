import { useRef, useState } from "react";
import { runZipImportFlow } from "../lib/zipImportFlow";

/** Always visible regardless of the current project's edit status — importing a zip starts an unrelated new project, not an edit to this one. */
export function ImportZipButton() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  function handleClick() {
    inputRef.current?.click();
  }

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await runZipImportFlow(file, setBusy);
  }

  return (
    <>
      <button type="button" className="share-button share-button--secondary" onClick={handleClick} disabled={busy}>
        {busy ? "Importing…" : "Import ZIP"}
      </button>
      <input ref={inputRef} type="file" accept=".zip" hidden onChange={(e) => void handleChange(e)} />
    </>
  );
}
