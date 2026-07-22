export interface LocalUser {
  name: string;
  color: string;
}

const ADJECTIVES = ["Swift", "Quiet", "Bold", "Sunny", "Amber", "Cosmic", "Nimble", "Gentle", "Clever", "Rapid"];
const NOUNS = ["Fox", "Otter", "Falcon", "Comet", "Maple", "Willow", "Harbor", "Ember", "Quartz", "Sparrow"];
// Distinct, roughly equal-brightness hues — legible as both a cursor color
// and white-on-color text in the name tag.
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#e6a100", "#c2185b"];

const STORAGE_KEY = "mini-overleaf:local-user";

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * One identity per browser tab (sessionStorage, not localStorage), so a
 * reload keeps your name/color stable but a second tab — e.g. to test
 * collaboration locally — gets its own, distinguishable identity.
 */
export function getLocalUser(): LocalUser {
  const cached = sessionStorage.getItem(STORAGE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Partial<LocalUser>;
      if (typeof parsed.name === "string" && typeof parsed.color === "string") {
        return { name: parsed.name, color: parsed.color };
      }
    } catch {
      // fall through and mint a new identity
    }
  }

  const user: LocalUser = { name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`, color: pick(PALETTE) };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  return user;
}
