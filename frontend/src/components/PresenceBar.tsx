import { useState } from "react";
import type { ConnectionStatus, Peer } from "./LatexEditor";
import type { LocalUser } from "../lib/identity";

interface Props {
  localUser: LocalUser;
  peers: Peer[];
  connectionStatus: ConnectionStatus;
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

export function PresenceBar({ localUser, peers, connectionStatus }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context) — the
      // URL is still right there in the address bar, so just do nothing.
    }
  }

  return (
    <div className="presence-bar">
      <span
        className={`connection-dot connection-dot--${connectionStatus}`}
        title={`Collaboration: ${STATUS_LABEL[connectionStatus]}`}
      />
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
      <button type="button" className="share-button" onClick={handleShare}>
        {copied ? "Link copied" : "Share"}
      </button>
    </div>
  );
}
