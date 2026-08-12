// HelloAria public API (v1) client. Auth is the user's API key from
// Settings -> Developer on the dashboard; everything rides the deployed
// REST surface — this app is a pure consumer.

import { getConfig } from "./state";

const BASE = "https://api.ductivity.in/v1";

export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

async function request<T>(path: string, init: RequestInit = {}, key?: string): Promise<T> {
    const apiKey = key ?? getConfig().apiKey;
    let res: Response;
    try {
        res = await fetch(`${BASE}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                ...(init.headers || {}),
            },
        });
    } catch {
        throw new ApiError(0, "Can't reach HelloAria — check your connection.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new ApiError(res.status, body?.error?.message || body?.message || `Request failed (${res.status})`);
    }
    return body as T;
}

// ---- shapes (from the v1 contract) ----

export interface Todo {
    id: string;
    message: string;
    due_date: string | null;
    category: string | null;
    completed: boolean;
}

export interface Reminder {
    id: string;
    message: string;
    scheduled_time: string | null;
    recurrence: string;
    status: "PENDING" | "SENT" | "FAILED";
    completed: boolean;
}

export interface CalendarEvent {
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    allDay?: boolean;
    location?: string;
    meetLink?: string;
    source: "google" | "microsoft";
}

export interface Me {
    user_id: string;
    name: string | null;
    timezone: string | null;
}

// ---- calls ----

/** Validates a key by fetching the profile. Throws ApiError on bad keys. */
export async function fetchMe(key?: string): Promise<Me> {
    const res = await request<{ success: boolean; data: Me }>("/me", {}, key);
    return res.data;
}

export async function fetchTodos(): Promise<Todo[]> {
    const res = await request<{ success: boolean; data: { todos: Todo[] } }>("/todos?status=active");
    return res.data?.todos || [];
}

export async function completeTodo(id: string): Promise<void> {
    await request(`/todos/${encodeURIComponent(id)}/complete`, { method: "POST" });
}

export async function fetchReminders(): Promise<Reminder[]> {
    const res = await request<{ success: boolean; data: { reminders: Reminder[] } }>("/reminders?status=active");
    return res.data?.reminders || [];
}

export async function fetchTodayEvents(): Promise<CalendarEvent[]> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const qs = `?startDate=${encodeURIComponent(start.toISOString())}&endDate=${encodeURIComponent(end.toISOString())}`;
    // Calendar responses pass through from the dashboard calendar API, so the
    // events array may sit at .events or .data.events depending on the path.
    const res = await request<any>(`/calendar/events${qs}`);
    return res?.data?.events || res?.events || [];
}

/** Send a chat message to Aria; returns her reply text. */
export async function sendToAria(message: string): Promise<string> {
    const res = await request<any>("/messages", {
        method: "POST",
        body: JSON.stringify({ message }),
    });
    // chat-api response shape: { success, message, ... }
    return res?.message || res?.data?.message || "…";
}

export interface Note {
    id: string;
    title: string | null;
    content: string;
    tags: string[];
    created_at: string;
}

export async function fetchNotes(): Promise<Note[]> {
    const res = await request<{ success: boolean; data: { notes: Note[] } }>("/notes");
    return res.data?.notes || [];
}

export async function createNote(content: string): Promise<void> {
    await request("/notes", { method: "POST", body: JSON.stringify({ content }) });
}

/** Calendar events for an arbitrary local day. */
export async function fetchEventsForDay(day: Date): Promise<CalendarEvent[]> {
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(day); end.setHours(23, 59, 59, 999);
    const qs = `?startDate=${encodeURIComponent(start.toISOString())}&endDate=${encodeURIComponent(end.toISOString())}`;
    const res = await request<any>(`/calendar/events${qs}`);
    return res?.data?.events || res?.events || [];
}

// ---- pet gallery (codex-pets.net, the OpenPets community share) ----

export interface GalleryPet {
    id: string;
    displayName: string;
    kind: string;
    spritesheetUrl: string;
    previewUrl: string;
}

import { fetch as nativeFetch } from "@tauri-apps/plugin-http";

/**
 * Public catalog — no HelloAria auth involved. Uses the Rust-proxied fetch:
 * codex-pets.net sends no Access-Control-Allow-Origin header, so a normal
 * webview fetch dies on CORS.
 */
export async function fetchPetGallery(): Promise<GalleryPet[]> {
    const res = await nativeFetch("https://codex-pets.net/api/pets");
    // (previews are fetched separately via fetchPreviewObjectUrl)
    if (!res.ok) throw new ApiError(res.status, "Couldn't load the pet gallery.");
    const body = await res.json();
    return (body?.pets || [])
        .filter((p: any) => p.spritesheetUrl && p.previewUrl && !p.ownerShadowbanned)
        .map((p: any) => ({
            id: p.id,
            displayName: p.displayName,
            kind: p.kind || "pet",
            spritesheetUrl: p.spritesheetUrl,
            previewUrl: p.previewUrl,
        }));
}

/**
 * Preview images through the Rust fetch too — the webview refuses to render
 * some cross-origin <img> loads from this host, so we hand it a blob URL.
 */
export async function fetchPreviewObjectUrl(url: string): Promise<string> {
    const res = await nativeFetch(url);
    if (!res.ok) throw new ApiError(res.status, "preview unavailable");
    const buf = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type: "image/webp" }));
}
