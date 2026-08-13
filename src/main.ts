// Aria Buddy — HelloAria's pet, living on your desktop.
// Onboarding: API key -> pick a pet (it's always named Aria).
// Pet mode: tap -> panel (Today / Todos / Calendar / Notes + chat with Aria);
// gear -> settings (size, where it lives, character, disconnect, close).

import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { PetSprite, PetLife } from "./sprite";
import {
    allPets, addCustomPet, BUNDLED_PETS, PET_SIZES, type PetSize, type OverlayMode,
    getConfig, saveConfig, clearConfig, isConfigured, petById,
} from "./state";
import { icon } from "./icons";
import {
    fetchMe, fetchTodos, completeTodo, fetchReminders, fetchEventsForDay,
    fetchNotes, createNote, sendToAria, fetchPetGallery, fetchPreviewObjectUrl, ApiError,
} from "./api";

const win = getCurrentWindow();

const COLLAPSED = { w: 280, h: 330 };
const EXPANDED = { w: 420, h: 720 };

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const petCanvas = $("#pet") as unknown as HTMLCanvasElement;
const bubbleEl = $("#bubble");
const panelEl = $("#panel");
const onboardingEl = $("#onboarding");
const effectsEl = $("#effects");

const sprite = new PetSprite(petCanvas);
let life: PetLife | null = null;
let panelOpen = false;
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------------------
// Window + pet sizing
// ---------------------------------------------------------------------------
function applyPetSize(): void {
    const w = PET_SIZES[getConfig().petSize];
    const h = Math.round((w * 208) / 192);
    document.documentElement.style.setProperty("--pet-w", `${w}px`);
    document.documentElement.style.setProperty("--pet-h", `${h}px`);
}

async function applyOverlayMode(): Promise<void> {
    const mode: OverlayMode = getConfig().overlayMode;
    try {
        // Native command only — the portable window APIs (setAlwaysOnTop &co)
        // rewrite the macOS window level and DROP the Spaces/full-screen
        // flags, which is the "pet doesn't follow me" bug. main.rs sets level
        // and collection behavior atomically.
        await invoke("set_overlay", { mode });
    } catch {
        /* stays in whatever mode the window opened with */
    }
}

async function resizeWindow(to: { w: number; h: number }): Promise<void> {
    try {
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.outerSize()).toLogical(scale);
        const x = Math.round(pos.x - (to.w - size.width) / 2);
        const y = Math.round(pos.y - (to.h - size.height));
        await win.setSize(new LogicalSize(to.w, to.h));
        await win.setPosition(new LogicalPosition(x, y));
    } catch {
        /* window API hiccup — layout still works at current size */
    }
}

// ---------------------------------------------------------------------------
// Speech bubble
// ---------------------------------------------------------------------------
function say(text: string, ms = 6000): void {
    clearTimeout(bubbleTimer);
    bubbleEl.textContent = text;
    bubbleEl.classList.remove("hidden");
    if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms);
}

function sayTyping(): void {
    clearTimeout(bubbleTimer);
    bubbleEl.innerHTML = `<span class="bubble-typing"><span></span><span></span><span></span></span>`;
    bubbleEl.classList.remove("hidden");
}

function sayWithIcon(iconName: string, text: string, ms = 6000): void {
    clearTimeout(bubbleTimer);
    bubbleEl.innerHTML = `<span class="bubble-ico">${icon(iconName, 13)}</span>${escapeHtml(text)}`;
    bubbleEl.classList.remove("hidden");
    if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble(): void {
    bubbleEl.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Pet interactions: drag moves the window, a clean click toggles the panel,
// lingering on the pet earns hearts.
// ---------------------------------------------------------------------------
let pressAt: { x: number; y: number } | null = null;
let dragging = false;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

petCanvas.addEventListener("mousedown", (e) => {
    pressAt = { x: e.screenX, y: e.screenY };
    dragging = false;
});
window.addEventListener("mousemove", (e) => {
    if (!pressAt || dragging) return;
    if (e.buttons === 0) { pressAt = null; return; } // released outside the window
    if (Math.hypot(e.screenX - pressAt.x, e.screenY - pressAt.y) > 5) {
        dragging = true;
        void win.startDragging();
    }
});
window.addEventListener("mouseup", () => {
    if (pressAt && !dragging) void togglePanel();
    pressAt = null;
    dragging = false;
});
petCanvas.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(() => {
        if (!panelOpen) life?.emote(icon("heart", 14), 3);
    }, 1500);
});
petCanvas.addEventListener("mouseleave", () => clearTimeout(hoverTimer));
window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen) void togglePanel();
});

// ---------------------------------------------------------------------------
// Quick panel
// ---------------------------------------------------------------------------
type Tab = "today" | "todos" | "calendar" | "notes";
let activeTab: Tab = "today";
let calendarDay = new Date();
let settingsOpen = false;

const TABS: Array<{ id: Tab; ico: string; label: string }> = [
    { id: "today", ico: "sun", label: "Today" },
    { id: "todos", ico: "check", label: "Todos" },
    { id: "calendar", ico: "calendar", label: "Calendar" },
    { id: "notes", ico: "note", label: "Notes" },
];

async function togglePanel(): Promise<void> {
    if (!isConfigured()) return;
    panelOpen = !panelOpen;
    if (panelOpen) {
        hideBubble();
        life?.suspend();
        await resizeWindow(EXPANDED);
        settingsOpen = false;
        renderPanelShell();
        panelEl.classList.remove("hidden");
        void renderTab(activeTab);
    } else {
        destroyPanelPreviews();
        panelEl.classList.add("hidden");
        await resizeWindow(COLLAPSED);
        life?.resume();
    }
}

function renderPanelShell(): void {
    const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    panelEl.innerHTML = `
    <div class="panel-head" data-tauri-drag-region>
      <div data-tauri-drag-region>
        <div class="panel-title" data-tauri-drag-region>Aria</div>
        <div class="panel-sub" data-tauri-drag-region>${today}</div>
      </div>
      <div class="head-actions">
        <button class="icon-btn" id="panel-settings" title="Settings">${icon("settings", 15)}</button>
        <button class="icon-btn" id="panel-close" title="Close">${icon("x", 15)}</button>
      </div>
    </div>
    <div class="tabs" id="tabs">
      ${TABS.map((t) => `<button class="tab${t.id === activeTab ? " active" : ""}" data-tab="${t.id}"><span class="tab-ico">${icon(t.ico, 15)}</span>${t.label}</button>`).join("")}
    </div>
    <div class="panel-body" id="panel-body"><div class="empty">Loading…</div></div>
    <form class="chat-bar" id="chat-form">
      <input class="chat-input" id="chat-input" placeholder="Ask Aria anything…" autocomplete="off" />
      <button class="send-btn" id="chat-send" type="submit">Send</button>
    </form>`;

    $("#panel-close").addEventListener("click", () => void togglePanel());
    $("#panel-settings").addEventListener("click", () => {
        settingsOpen = !settingsOpen;
        if (settingsOpen) renderSettings();
        else void renderTab(activeTab);
    });
    panelEl.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
        b.addEventListener("click", () => {
            settingsOpen = false;
            activeTab = b.dataset.tab as Tab;
            panelEl.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
            void renderTab(activeTab);
        });
    });
    $("#chat-form").addEventListener("submit", (e) => {
        e.preventDefault();
        void handleChat();
    });
}

// Sprite previews rendered inside the panel body — destroyed on every
// re-render, otherwise each settings visit leaks a rAF draw loop per card.
let panelPreviews: PetSprite[] = [];
const destroyPanelPreviews = () => {
    panelPreviews.forEach((p) => p.destroy());
    panelPreviews = [];
};

const panelBody = (): HTMLElement => $("#panel-body");

const fmtTime = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function renderTab(tab: Tab): Promise<void> {
    destroyPanelPreviews();
    panelBody().innerHTML = `<div class="empty">Loading…</div>`;
    try {
        if (tab === "today") await renderToday();
        else if (tab === "todos") await renderTodos();
        else if (tab === "calendar") await renderCalendar();
        else await renderNotes();
    } catch (e) {
        panelBody().innerHTML = `<div class="empty">${escapeHtml(e instanceof Error ? e.message : "Something went wrong")}</div>`;
    }
}

// ------------------------------------------------------------------- Today
async function renderToday(): Promise<void> {
    const now = new Date();
    const [events, reminders] = await Promise.all([fetchEventsForDay(now), fetchReminders()]);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    const items: Array<{ time: string; sort: number; html: string }> = [];
    for (const ev of events) {
        items.push({
            time: ev.allDay ? "all day" : fmtTime(ev.startTime),
            sort: new Date(ev.startTime).getTime(),
            html: `<div class="row-text">${escapeHtml(ev.title)}<div class="sub">${ev.source === "google" ? "Google" : "Outlook"}${ev.location ? ` · ${escapeHtml(ev.location)}` : ""}</div></div>`,
        });
    }
    for (const r of reminders) {
        if (!r.scheduled_time) continue;
        const t = new Date(r.scheduled_time);
        if (t < startOfDay || t > endOfDay) continue;
        items.push({
            time: fmtTime(r.scheduled_time),
            sort: t.getTime(),
            html: `<div class="row-text">${escapeHtml(r.message)}<div class="sub">reminder${r.recurrence !== "none" ? ` · ${escapeHtml(r.recurrence)}` : ""}</div></div>`,
        });
    }
    items.sort((a, b) => a.sort - b.sort);

    const upcoming = reminders
        .filter((r) => r.scheduled_time && new Date(r.scheduled_time) > endOfDay)
        .sort((a, b) => (a.scheduled_time! < b.scheduled_time! ? -1 : 1))
        .slice(0, 3);

    panelBody().innerHTML =
        (items.length
            ? items.map((i) => `<div class="row"><div class="row-time">${i.time}</div>${i.html}</div>`).join("")
            : `<div class="empty">Nothing scheduled today.<br/>Enjoy the calm.</div>`) +
        (upcoming.length
            ? `<div class="section-label">Coming up</div>` + upcoming.map((r) => {
                const d = new Date(r.scheduled_time!);
                return `<div class="row"><div class="row-time">${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}<br/>${fmtTime(r.scheduled_time)}</div><div class="row-text">${escapeHtml(r.message)}</div></div>`;
            }).join("")
            : "");
}

// ------------------------------------------------------------------- Todos
async function renderTodos(): Promise<void> {
    const todos = await fetchTodos();
    if (todos.length === 0) {
        panelBody().innerHTML = `<div class="empty">No open todos.<br/>Aria is proud of you.</div>`;
        return;
    }
    const byCategory = new Map<string, typeof todos>();
    for (const t of todos) {
        const cat = t.category || "General";
        byCategory.set(cat, [...(byCategory.get(cat) || []), t]);
    }
    panelBody().innerHTML = [...byCategory.entries()]
        .map(([cat, list]) =>
            `<div class="section-label">${escapeHtml(cat)}</div>` +
            list.map((t) =>
                `<div class="row">
                    <button class="check" data-id="${escapeHtml(t.id)}" title="Complete"></button>
                    <div class="row-text">${escapeHtml(t.message)}${t.due_date ? `<div class="sub">due ${fmtTime(t.due_date)}</div>` : ""}</div>
                 </div>`
            ).join("")
        ).join("");

    panelBody().querySelectorAll<HTMLButtonElement>(".check").forEach((btn) => {
        btn.addEventListener("click", async () => {
            btn.classList.add("done");
            btn.disabled = true;
            try {
                await completeTodo(btn.dataset.id as string);
                life?.celebrate();
                setTimeout(() => void renderTodos(), 700);
            } catch {
                btn.classList.remove("done");
                btn.disabled = false;
            }
        });
    });
}

// ---------------------------------------------------------------- Calendar
async function renderCalendar(): Promise<void> {
    const day = calendarDay;
    const isToday = day.toDateString() === new Date().toDateString();
    const label = day.toLocaleDateString(undefined, { weekday: "long" });
    const sub = day.toLocaleDateString(undefined, { month: "long", day: "numeric" });

    panelBody().innerHTML = `
      <div class="day-nav">
        <button class="day-btn" id="day-prev">${icon("chevronLeft", 15)}</button>
        <div class="day-nav-label">${isToday ? "Today" : label}<span class="sub">${sub}</span></div>
        <button class="day-btn" id="day-next">${icon("chevronRight", 15)}</button>
      </div>
      <div id="day-items"><div class="empty">Loading…</div></div>`;

    $("#day-prev").addEventListener("click", () => {
        calendarDay = new Date(calendarDay); calendarDay.setDate(calendarDay.getDate() - 1);
        void renderCalendar();
    });
    $("#day-next").addEventListener("click", () => {
        calendarDay = new Date(calendarDay); calendarDay.setDate(calendarDay.getDate() + 1);
        void renderCalendar();
    });

    const [events, reminders] = await Promise.all([fetchEventsForDay(day), fetchReminders()]);
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(day); end.setHours(23, 59, 59, 999);

    const items: Array<{ time: string; sort: number; html: string }> = [];
    for (const ev of events) {
        items.push({
            time: ev.allDay ? "all day" : fmtTime(ev.startTime),
            sort: new Date(ev.startTime).getTime(),
            html: `<div class="row-text">${escapeHtml(ev.title)}<div class="sub">${fmtTime(ev.startTime)} – ${fmtTime(ev.endTime)}${ev.location ? ` · ${escapeHtml(ev.location)}` : ""}</div></div>`,
        });
    }
    for (const r of reminders) {
        if (!r.scheduled_time) continue;
        const t = new Date(r.scheduled_time);
        if (t < start || t > end) continue;
        items.push({
            time: fmtTime(r.scheduled_time),
            sort: t.getTime(),
            html: `<div class="row-text">${escapeHtml(r.message)}<div class="sub">reminder</div></div>`,
        });
    }
    items.sort((a, b) => a.sort - b.sort);

    const target = document.querySelector("#day-items");
    if (target) {
        target.innerHTML = items.length
            ? items.map((i) => `<div class="row"><div class="row-time">${i.time}</div>${i.html}</div>`).join("")
            : `<div class="empty">Nothing on this day.</div>`;
    }
}

// ------------------------------------------------------------------- Notes
async function renderNotes(): Promise<void> {
    panelBody().innerHTML = `
      <form class="quick-add" id="note-form">
        <input class="mini-input" id="note-input" placeholder="Jot a quick note…" autocomplete="off" />
        <button class="send-btn" type="submit">Add</button>
      </form>
      <div id="notes-list"><div class="empty">Loading…</div></div>`;

    $("#note-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = $("#note-input") as HTMLInputElement;
        const content = input.value.trim();
        if (!content) return;
        input.value = "";
        try {
            await createNote(content);
            life?.emote(icon("note", 14), 1);
            void loadNotesList();
        } catch {
            say("Couldn't save that note — try again?", 4000);
        }
    });

    await loadNotesList();
}

async function loadNotesList(): Promise<void> {
    const target = document.querySelector("#notes-list");
    if (!target) return;
    const notes = await fetchNotes();
    target.innerHTML = notes.length
        ? notes.slice(0, 30).map((n) => `
            <div class="note-card">
                ${n.title ? `<div class="note-title">${escapeHtml(n.title)}</div>` : ""}
                <div class="note-content">${escapeHtml(n.content)}</div>
                <div class="note-meta">${new Date(n.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${n.tags.length ? ` · ${n.tags.map(escapeHtml).join(", ")}` : ""}</div>
            </div>`).join("")
        : `<div class="empty">No notes yet — jot one above.</div>`;
}

// ---------------------------------------------------------------- Settings
function renderSettings(): void {
    destroyPanelPreviews();
    const cfg = getConfig();
    panelBody().innerHTML = `
      <div class="settings-group">
        <div class="settings-label">Pet size</div>
        <div class="segmented" id="seg-size">
          ${(["small", "medium", "large"] as PetSize[]).map((s) =>
        `<button class="segment${cfg.petSize === s ? " active" : ""}" data-size="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-label">Where Aria lives</div>
        <div class="segmented" id="seg-mode">
          <button class="segment${cfg.overlayMode === "overlay" ? " active" : ""}" data-mode="overlay">Over all apps</button>
          <button class="segment${cfg.overlayMode === "desktop" ? " active" : ""}" data-mode="desktop">On the desktop</button>
        </div>
        <div class="settings-note">Over all apps floats on top of every window. On the desktop sits above your wallpaper, underneath your apps.</div>
      </div>
      <div class="settings-group">
        <div class="settings-label">Character</div>
        <div class="pet-row" id="pet-row"></div>
        <div class="settings-note">Add any spritesheet in the OpenPets format below, or browse the community gallery.</div>
        <form class="quick-add" id="custom-pet-form" style="margin-top:10px">
          <input class="mini-input" id="custom-pet-url" placeholder="Paste a spritesheet URL to add your own…" autocomplete="off" />
          <button class="send-btn" type="submit">Add</button>
        </form>
        <div class="settings-note">Any sheet in the OpenPets format works (192×208 frames, 8×9 grid).</div>
      </div>
      <div class="settings-group">
        <div class="settings-label">Pet gallery</div>
        <div id="gallery-area"><button class="ghost-btn" id="btn-gallery">Browse the community gallery</button></div>
        <div class="settings-note">Third-party community content, streamed from Codex Pets. Rights belong to their creators — HelloAria doesn\u2019t bundle or redistribute these.</div>
      </div>
      <div class="settings-group">
        <div class="settings-label">Account</div>
        <button class="danger-btn" id="btn-disconnect">Disconnect HelloAria account</button>
        <button class="danger-btn" id="btn-quit">Close Aria Buddy</button>
      </div>`;

    panelBody().querySelectorAll<HTMLButtonElement>("#seg-size .segment").forEach((b) => {
        b.addEventListener("click", () => {
            saveConfig({ petSize: b.dataset.size as PetSize });
            applyPetSize();
            panelBody().querySelectorAll("#seg-size .segment").forEach((s) => s.classList.toggle("active", s === b));
        });
    });
    panelBody().querySelectorAll<HTMLButtonElement>("#seg-mode .segment").forEach((b) => {
        b.addEventListener("click", () => {
            saveConfig({ overlayMode: b.dataset.mode as OverlayMode });
            void applyOverlayMode();
            panelBody().querySelectorAll("#seg-mode .segment").forEach((s) => s.classList.toggle("active", s === b));
        });
    });

    const row = $("#pet-row");
    const previews = panelPreviews; // tracked; destroyed on re-render
    for (const p of allPets()) {
        const card = document.createElement("div");
        card.className = "pet-mini" + (p.id === cfg.petId ? " selected" : "");
        card.innerHTML = `<canvas width="192" height="208"></canvas><div class="pet-label">${escapeHtml(p.label)}</div>`;
        card.addEventListener("click", async () => {
            saveConfig({ petId: p.id });
            row.querySelectorAll(".pet-mini").forEach((c) => c.classList.toggle("selected", c === card));
            try {
                await sprite.load(p.sheet);
            } catch {
                say("Couldn't load that character — check your connection.", 5000);
            }
        });
        row.appendChild(card);
        const pv = new PetSprite(card.querySelector("canvas") as HTMLCanvasElement);
        pv.load(p.sheet).catch(() => card.classList.add("hidden"));
        previews.push(pv);
    }

    $("#custom-pet-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = $("#custom-pet-url") as HTMLInputElement;
        const url = input.value.trim();
        if (!/^https:\/\//.test(url)) return say("Character URLs must start with https://", 4000);
        // Validate it actually loads as an image before saving.
        const probe = new PetSprite(document.createElement("canvas"));
        try {
            await probe.load(url);
            probe.destroy();
            addCustomPet(`Custom ${getConfig().customPets.length + 1}`, url);
            input.value = "";
            renderSettings(); // re-render with the new character in the row
        } catch {
            probe.destroy();
            say("Couldn't load that spritesheet — check the URL.", 5000);
        }
    });

    // HelloAria's own character names — we never display or store the
    // gallery's original names (many are trademarked characters).
    const BUDDY_NAMES = [
        "Pixel", "Mocha", "Scout", "Nova", "Biscuit", "Ziggy", "Clover", "Onyx",
        "Pepper", "Miso", "Waffle", "Juniper", "Cosmo", "Maple", "Echo", "Sprout",
        "Tofu", "Comet", "Poppy", "Nimbus", "Fig", "Dash", "Willow", "Bean",
        "Sable", "Kiwi", "Ember", "Lumen", "Pesto", "Orbit",
    ];

    $("#btn-gallery").addEventListener("click", async () => {
        const area = $("#gallery-area");
        area.innerHTML = `<div class="empty">Loading gallery…</div>`;
        try {
            const pets = await fetchPetGallery();
            area.innerHTML = `<div class="gallery-grid" id="gallery-row"></div>`;
            const grow = $("#gallery-row");
            pets.forEach((g, i) => {
                const ourName = BUDDY_NAMES[i % BUDDY_NAMES.length] + (i >= BUDDY_NAMES.length ? ` ${Math.floor(i / BUDDY_NAMES.length) + 1}` : "");
                const card = document.createElement("div");
                card.className = "pet-mini";
                card.innerHTML = `<img alt="" /><div class="pet-label">${escapeHtml(ourName)}</div>`;
                const img = card.querySelector("img") as HTMLImageElement | null;
                if (img) {
                    // Try the direct URL first — WebView2 (Windows) renders
                    // cross-origin <img> fine. If it fails (WebKit/macOS is
                    // pickier), fall back to a Rust-proxied blob URL.
                    img.onerror = () => {
                        img.onerror = null;
                        fetchPreviewObjectUrl(g.previewUrl)
                            .then((blobUrl) => {
                                img.onload = () => URL.revokeObjectURL(blobUrl);
                                img.src = blobUrl;
                            })
                            .catch(() => card.classList.add("hidden"));
                    };
                    img.src = g.previewUrl;
                }
                card.addEventListener("click", async () => {
                    const added = addCustomPet(ourName, g.spritesheetUrl, `gallery-${g.id}`);
                    saveConfig({ petId: added.id });
                    grow.querySelectorAll(".pet-mini").forEach((c) => c.classList.toggle("selected", c === card));
                    try {
                        await sprite.load(added.sheet);
                    } catch {
                        say("Couldn't load that character — check your connection.", 5000);
                    }
                });
                grow.appendChild(card);
            });
        } catch {
            area.innerHTML = `<div class="empty">Couldn't reach the gallery — try again later.</div>`;
        }
    });

    $("#btn-disconnect").addEventListener("click", () => {
        clearConfig();
        location.reload();
    });
    $("#btn-quit").addEventListener("click", () => void win.close());
}

// ---------------------------------------------------------------------------
// Chat with Aria — replies arrive in the pet's speech bubble.
// ---------------------------------------------------------------------------
async function handleChat(): Promise<void> {
    const input = $("#chat-input") as HTMLInputElement;
    const send = $("#chat-send") as HTMLButtonElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send.disabled = true;
    sprite.set("review", "infinite");
    sayTyping();
    try {
        const reply = await sendToAria(text);
        sprite.set("waving", 1);
        say(reply, 14_000);
    } catch (e) {
        life?.oops();
        say(e instanceof Error ? e.message : "That didn't get through — try again?", 6000);
    } finally {
        send.disabled = false;
        if (sprite.current === "review") sprite.set("idle");
    }
}

// ---------------------------------------------------------------------------
// Reminder watcher — the pet delivers due reminders on your desktop.
// ---------------------------------------------------------------------------
const announced = new Set<string>();

async function watchReminders(): Promise<void> {
    try {
        const reminders = await fetchReminders();
        const now = Date.now();
        if (announced.size > 500) announced.clear(); // bounded, day-scale app runs
        for (const r of reminders) {
            if (!r.scheduled_time) continue;
            // Key by occurrence, not id — recurring reminders keep their id
            // and would otherwise announce only once per app run.
            const key = `${r.id}#${r.scheduled_time}`;
            if (announced.has(key)) continue;
            const t = new Date(r.scheduled_time).getTime();
            if (t <= now && now - t < 5 * 60_000) {
                announced.add(key);
                sprite.set("waving", 3);
                sayWithIcon("bell", r.message, 20_000);
                break; // one at a time — the pet isn't a spam cannon
            }
        }
    } catch {
        /* offline — try again next tick */
    }
}

// ---------------------------------------------------------------------------
// Onboarding: API key -> choose your character (it's Aria either way)
// ---------------------------------------------------------------------------
function showKeyStep(err = ""): void {
    onboardingEl.classList.remove("hidden");
    onboardingEl.innerHTML = `
    <div data-tauri-drag-region style="position:absolute;inset:0 0 auto 0;height:40px;"></div>
    <div class="ob-logo">${icon("sparkles", 30)}</div>
    <div class="ob-title">Aria Buddy</div>
    <div class="ob-sub">A tiny HelloAria companion for your desktop. Paste an API key to connect your account.</div>
    <input class="ob-input" id="ob-key" placeholder="ha_live_…" spellcheck="false" />
    <button class="ob-btn" id="ob-connect">Connect</button>
    <div class="ob-error">${escapeHtml(err)}</div>
    <div class="ob-hint">Get a key in the dashboard →<br/><b>Settings → Developer → Create key</b></div>`;

    const btn = $("#ob-connect") as HTMLButtonElement;
    const input = $("#ob-key") as HTMLInputElement;
    const connect = async () => {
        const key = input.value.trim();
        if (!key.startsWith("ha_")) return showKeyStep("That doesn't look like a HelloAria API key.");
        btn.disabled = true;
        btn.textContent = "Connecting…";
        try {
            const me = await fetchMe(key);
            saveConfig({ apiKey: key, userName: me.name || "" });
            showPetStep();
        } catch (e) {
            showKeyStep(e instanceof ApiError && e.status === 401
                ? "That key was rejected — check it and try again."
                : e instanceof Error ? e.message : "Couldn't connect.");
        }
    };
    btn.addEventListener("click", connect);
    input.addEventListener("keydown", (e) => e.key === "Enter" && connect());
    input.focus();
}

function showPetStep(): void {
    let selected = BUNDLED_PETS[0].id;
    onboardingEl.innerHTML = `
    <div data-tauri-drag-region style="position:absolute;inset:0 0 auto 0;height:40px;"></div>
    <div class="ob-title">Choose Aria's look</div>
    <div class="ob-sub">Your buddy is Aria — pick the character it shows up as. You can change it anytime in settings.</div>
    <div class="pet-grid" id="pet-grid"></div>
    <button class="ob-btn" id="ob-done">Bring Aria to life</button>
    <div class="ob-error"></div>`;

    const grid = $("#pet-grid");
    const previews: PetSprite[] = [];
    for (const p of allPets()) {
        const card = document.createElement("div");
        card.className = "pet-choice" + (p.id === selected ? " selected" : "");
        card.innerHTML = `<canvas width="192" height="208"></canvas><div class="pet-label">${escapeHtml(p.label)}</div>`;
        card.addEventListener("click", () => {
            selected = p.id;
            grid.querySelectorAll(".pet-choice").forEach((c) => c.classList.toggle("selected", c === card));
        });
        grid.appendChild(card);
        const pv = new PetSprite(card.querySelector("canvas") as HTMLCanvasElement);
        pv.load(p.sheet).catch(() => card.classList.add("hidden"));
        previews.push(pv);
    }

    $("#ob-done").addEventListener("click", () => {
        saveConfig({ petId: selected, petName: "Aria" });
        previews.forEach((p) => p.destroy());
        void enterPetMode(true);
    });
}

// ---------------------------------------------------------------------------
// Pet mode
// ---------------------------------------------------------------------------
async function enterPetMode(fresh = false): Promise<void> {
    onboardingEl.classList.add("hidden");
    applyPetSize();
    await applyOverlayMode();
    await resizeWindow(COLLAPSED);

    const cfg = getConfig();
    try {
        await sprite.load(petById(cfg.petId).sheet);
    } catch {
        // Remote character unavailable (offline?) — fall back to the bundled one.
        saveConfig({ petId: BUNDLED_PETS[0].id });
        await sprite.load(BUNDLED_PETS[0].sheet);
    }

    life?.destroy();
    life = new PetLife(sprite, {
        walkRange: Math.max(30, (COLLAPSED.w - PET_SIZES[cfg.petSize]) / 2 - 16),
        effectsEl,
        sleepFx: icon("moon", 13),
        celebrateFx: icon("sparkles", 14),
        oopsFx: icon("droplet", 13),
    });

    if (fresh) {
        sprite.set("jumping", 2);
        say(`Hi${cfg.userName ? ` ${cfg.userName.split(" ")[0]}` : ""}! I'm Aria. Tap me anytime.`, 7000);
    } else {
        try {
            const todos = await fetchTodos();
            if (todos.length > 0) say(`${todos.length} open todo${todos.length === 1 ? "" : "s"} today. Tap me to see them.`, 6000);
        } catch { /* offline is fine */ }
    }

    setInterval(() => void watchReminders(), 60_000);
    void watchReminders();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (isConfigured()) {
    void enterPetMode();
} else {
    void resizeWindow(EXPANDED).then(() => showKeyStep());
}
