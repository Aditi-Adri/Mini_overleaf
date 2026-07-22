const STYLE_ELEMENT_ID = "yjs-awareness-styles";
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_NAME_LENGTH = 40;

/**
 * y-monaco only attaches `.yRemoteSelection-<clientId>` / `.yRemoteSelectionHead-<clientId>`
 * class names to its cursor/selection decorations — it deliberately leaves
 * color and name-tag rendering to the app. This generates the CSS for that.
 *
 * Awareness state is set directly by each connected peer and broadcast
 * verbatim by the server (that's how Yjs awareness is designed to work —
 * there's no server-side validation). Since `name` ends up inside a CSS
 * `content: "..."` string and `color` inside a CSS color value, both are
 * validated/escaped before being written into the injected stylesheet, so
 * one misbehaving peer can't break out into arbitrary CSS.
 */
export function renderAwarenessStyles(states: Map<number, Record<string, unknown>>, localClientId: number): void {
  let styleEl = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  states.forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const user = state.user as { name?: unknown; color?: unknown } | undefined;
    if (!user) return;

    const color = typeof user.color === "string" && HEX_COLOR_RE.test(user.color) ? user.color : "#888888";
    const rawName = typeof user.name === "string" && user.name.trim().length > 0 ? user.name : "Guest";
    const name = escapeCssString(rawName.slice(0, MAX_NAME_LENGTH));

    rules.push(`
      .yRemoteSelection-${clientId} { background-color: ${color}40; }
      .yRemoteSelectionHead-${clientId} {
        position: relative;
        border-left: 2px solid ${color};
      }
      .yRemoteSelectionHead-${clientId}::after {
        content: "${name}";
        position: absolute;
        top: -1.15em;
        left: -2px;
        font-size: 11px;
        line-height: 1.4;
        padding: 0 4px;
        background: ${color};
        color: #fff;
        border-radius: 2px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 30;
      }
    `);
  });

  styleEl.textContent = rules.join("\n");
}

function escapeCssString(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, "");
}
