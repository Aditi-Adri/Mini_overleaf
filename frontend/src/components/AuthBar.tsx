import { useEffect, useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import {
  getCurrentUser,
  isCurrentProjectSaved,
  saveCurrentProject,
  signInWithGoogle,
  signOut,
  type AuthUser,
} from "../lib/auth";

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

interface Props {
  projectId: string;
  editToken: string | null;
  onOpenMyProjects: () => void;
}

/**
 * Entirely optional layer on top of the app's normal anonymous/link-sharing
 * flow: with no VITE_GOOGLE_CLIENT_ID configured this renders nothing at
 * all, and even signed in, nothing here changes what an anonymous visitor
 * can do — "Save" just adds this project to the signed-in user's own list.
 */
export function AuthBar({ projectId, editToken, onOpenMyProjects }: Props) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setCheckedSession(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setSaved(false);
      return;
    }
    let cancelled = false;
    isCurrentProjectSaved(projectId).then((s) => {
      if (!cancelled) setSaved(s);
    });
    return () => {
      cancelled = true;
    };
  }, [user, projectId]);

  if (!googleClientId || !checkedSession) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await saveCurrentProject(projectId, editToken);
      setSaved(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setUser(null);
  }

  if (!user) {
    return (
      <GoogleLogin
        size="medium"
        text="signin"
        onSuccess={(credential) => {
          if (!credential.credential) return;
          signInWithGoogle(credential.credential)
            .then(setUser)
            .catch((err: unknown) => window.alert(err instanceof Error ? err.message : String(err)));
        }}
        onError={() => window.alert("Google sign-in failed — please try again.")}
      />
    );
  }

  return (
    <div className="auth-bar">
      {user.pictureUrl && <img className="auth-avatar" src={user.pictureUrl} alt="" title={user.name} referrerPolicy="no-referrer" />}
      <button type="button" className="share-button share-button--secondary" onClick={onOpenMyProjects}>
        My Projects
      </button>
      <button type="button" className="share-button share-button--secondary" onClick={() => void handleSave()} disabled={saving || saved}>
        {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="share-button share-button--secondary" onClick={() => void handleSignOut()}>
        Sign out
      </button>
    </div>
  );
}
