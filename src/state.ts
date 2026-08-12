// Local config — API key, chosen pet, name, size. Lives in the webview's
// localStorage (persisted per-install by Tauri).

export interface PetDef {
    id: string;
    label: string;
    sheet: string; // bundled module URL or remote spritesheet URL
    remote?: boolean;
}

import defaultSheet from "./pets/default/spritesheet.webp";
import tuxSheet from "./pets/tux/spritesheet.webp";

/** Bundled pets — ship inside the app, always available offline. */
export const BUNDLED_PETS: PetDef[] = [
    { id: "buddy", label: "Buddy", sheet: defaultSheet },
    { id: "tux", label: "Tux", sheet: tuxSheet },
];

/**
 * Official presets are ONLY assets we clearly have rights to: Buddy (MIT,
 * ships in the OpenPets repo) and Tux (permissive, credit Larry Ewing).
 * Everything else — including famous fan-art characters — is user-initiated
 * via the community gallery or a pasted URL, never pre-loaded by us.
 */
export const COMMUNITY_PETS: PetDef[] = [];

/** Every selectable pet: bundled + community + the user's own added sheets. */
export function allPets(): PetDef[] {
    return [...BUNDLED_PETS, ...COMMUNITY_PETS, ...getConfig().customPets];
}

/** Register a spritesheet URL as a character (dedupes by sheet URL). */
export function addCustomPet(label: string, sheetUrl: string, id?: string): PetDef {
    const cfg = getConfig();
    const existing = cfg.customPets.find((p) => p.sheet === sheetUrl);
    if (existing) return existing;
    const pet: PetDef = {
        id: id || `custom-${Date.now().toString(36)}`,
        label: label || "Custom",
        sheet: sheetUrl,
        remote: true,
    };
    saveConfig({ customPets: [...cfg.customPets, pet] });
    return pet;
}

export function removeCustomPet(id: string): void {
    const cfg = getConfig();
    saveConfig({ customPets: cfg.customPets.filter((p) => p.id !== id) });
}

/** Pet display sizes (width px; height keeps the 192:208 frame ratio). */
export const PET_SIZES = {
    small: 76,
    medium: 100,
    large: 132,
} as const;

export type PetSize = keyof typeof PET_SIZES;

/** Where the buddy lives: floating over every app, or down on the desktop
 *  (above the wallpaper, underneath your windows). */
export type OverlayMode = "overlay" | "desktop";

export interface Config {
    apiKey: string;
    petId: string;
    petName: string;
    userName: string;
    petSize: PetSize;
    overlayMode: OverlayMode;
    customPets: PetDef[];
}

const KEY = "aria-buddy-config-v1";

const DEFAULTS: Config = {
    apiKey: "",
    petId: "buddy",
    petName: "",
    userName: "",
    petSize: "small",
    overlayMode: "overlay",
    customPets: [],
};

export function getConfig(): Config {
    try {
        return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}")) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function saveConfig(patch: Partial<Config>): Config {
    const next = { ...getConfig(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
}

export function clearConfig(): void {
    localStorage.removeItem(KEY);
}

export function isConfigured(): boolean {
    const c = getConfig();
    return !!c.apiKey && !!c.petName;
}

export function petById(id: string): PetDef {
    return allPets().find((p) => p.id === id) || BUNDLED_PETS[0];
}
