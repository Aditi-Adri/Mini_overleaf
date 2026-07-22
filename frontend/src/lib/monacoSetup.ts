import { loader } from "@monaco-editor/react";
// The package root re-exports these same bindings from
// esm/vs/editor/editor.api.js (see monaco-editor/esm/vs/index.js) — using it
// here avoids the exports-map resolution issue on that deep path (see the
// Vite alias below) while still sharing the identical monaco-editor
// instance/objects with y-monaco.
import * as monaco from "monaco-editor";

// @monaco-editor/react defaults to lazy-loading monaco-editor from a CDN
// (jsdelivr) via an AMD script tag — a *second*, separate monaco-editor
// instance from the one y-monaco statically imports for its MonacoBinding.
// Two instances would mean MonacoBinding's `monaco.Range`/`monaco.Selection`
// calls don't necessarily line up with the editor/model instances actually
// rendered on screen. Pointing the loader at this same imported instance
// keeps exactly one monaco-editor in the app, and also drops the CDN
// round-trip (and its offline/no-network failure mode) from first load.
loader.config({ monaco });
