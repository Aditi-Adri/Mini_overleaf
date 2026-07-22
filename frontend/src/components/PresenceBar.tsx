import { useState } from "react";
import type { ConnectionStatus } from "./LatexEditor";
import type { ProjectPeer } from "../hooks/useProjectPresence";
import type { LocalUser } from "../lib/identity";

interface Props {
  localUser: LocalUser;
  peers: ProjectPeer[];
  connectionStatus: ConnectionStatus;
  isEditor: boolean;
  editLink: string;
  viewLink: string;
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Disconnected",
};

export function PresenceBar({ localUser, peers, connectionStatus, isEditor, editLink, viewLink }: Props) {
  const [copied, setCopied] = useState<"edit" | "view" | null>(null);

  async function copy(which: "edit" | "view", link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context) — the
      // link is still right there to select manually, nothing else to do.
    }
  }

  return (
    <div className="presence-bar">
      {isEditor ? (
        <span
          className={`connection-dot connection-dot--${connectionStatus}`}
          title={`Collaboration: ${STATUS_LABEL[connectionStatus]}`}
        />
      ) : (
        <span className="connection-dot connection-dot--readonly" title="You're viewing in read-only mode" />
      )}
      <div className="avatar-stack">
        <span className="avatar" style={{ backgroundColor: localUser.color }} title={`${localUser.name} (you)`}>
          {initials(localUser.name)}
        </span>
        {peers.map((peer) => (
          <span key={peer.clientId} className="avatar" style={{ backgroundColor: peer.color }} title={peer.name}>
            {initials(peer.name)}
          </span>
        ))}
      </div>
      {isEditor && (
        <button type="button" className="share-button" onClick={() => copy("edit", editLink)}>
          {copied === "edit" ? "Edit link copied" : "Share"}
        </button>
      )}
      <button type="button" className="share-button share-button--secondary" onClick={() => copy("view", viewLink)}>
        {copied === "view" ? "View link copied" : "Copy view-only link"}
      </button>
    </div>
  );
}
