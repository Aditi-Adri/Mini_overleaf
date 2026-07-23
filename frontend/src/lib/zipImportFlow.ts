import { uploadZipProject } from "./api";
import { editLinkFor, storeEditToken } from "./room";

/**
 * Confirms, uploads, and navigates to a brand-new project extracted from a
 * zip. Shared by the dedicated "Import ZIP" button and by the regular file
 * Upload button (which redirects here instead of silently attaching a .zip
 * as an opaque, never-extracted binary file — see FileTree.tsx).
 */
export async function runZipImportFlow(file: File, onBusyChange: (busy: boolean) => void): Promise<void> {
  const proceed = window.confirm(
    `Import "${file.name}" as a new project? This creates a separate project with its own share link — it won't be merged into the one you're viewing now.`
  );
  if (!proceed) return;

  onBusyChange(true);
  try {
    const result = await uploadZipProject(file);
    if (result.skipped.length > 0) {
      window.alert(
        `Imported, but ${result.skipped.length} entr${result.skipped.length === 1 ? "y was" : "ies were"} skipped for unsafe/invalid paths:\n${result.skipped.join("\n")}`
      );
    }
    storeEditToken(result.project.id, result.editToken);
    window.location.href = editLinkFor(result.project.id, result.editToken);
  } catch (err) {
    window.alert(`Couldn't import that zip: ${err instanceof Error ? err.message : String(err)}`);
    onBusyChange(false);
  }
}

export function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}
