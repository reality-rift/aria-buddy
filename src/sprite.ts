// Sprite animator + life engine for the OpenPets universal sheet format
// (MIT): 192x208 frames, 8 columns x 9 rows, one animation per row.
//
// PetSprite draws frames; PetLife layers behavior on top: ambient fidgets,
// real walking (run animation + horizontal travel), sleep with floating 💤
// after long inactivity, and hover-hearts. All 9 sheet animations get used.

export type SpriteState =
    | "idle" | "running-right" | "running-left" | "waving" | "jumping"
    | "failed" | "waiting" | "running" | "review";

interface StateDef {
    row: number;
    frames: number;
    durationMs: number;
}

export const FRAME_W = 192;
export const FRAME_H = 208;

const STATES: Record<SpriteState, StateDef> = {
    idle: { row: 0, frames: 6, durationMs: 5500 },
    "running-right": { row: 1, frames: 8, durationMs: 1060 },
    "running-left": { row: 2, frames: 8, durationMs: 1060 },
    waving: { row: 3, frames: 4, durationMs: 700 },
    jumping: { row: 4, frames: 5, durationMs: 840 },
    failed: { row: 5, frames: 8, durationMs: 1220 },
    waiting: { row: 6, frames: 6, durationMs: 1400 },
    running: { row: 7, frames: 6, durationMs: 820 },
    review: { row: 8, frames: 6, durationMs: 1030 },
};

export class PetSprite {
    private ctx: CanvasRenderingContext2D;
    private sheet: HTMLImageElement | null = null;
    private state: SpriteState = "idle";
    private stateStart = 0;
    private iterations: number | "infinite" = "infinite";
    private onDone: (() => void) | null = null;
    private rafId = 0;

    constructor(private canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d unavailable");
        this.ctx = ctx;
    }

    async load(sheetUrl: string): Promise<void> {
        this.sheet = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            // NO crossOrigin here: the sprite hosts don't send
            // Access-Control-Allow-Origin, and a crossorigin request without it
            // fails outright. We only draw (never read pixels back), so a
            // tainted canvas is perfectly fine.
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`failed to load ${sheetUrl}`));
            img.src = sheetUrl;
        });
        this.stateStart = performance.now();
        if (!this.rafId) this.rafId = requestAnimationFrame(this.frame);
    }

    /** Switch animation. Non-infinite states return to idle and call onDone. */
    set(state: SpriteState, iterations: number | "infinite" = "infinite", onDone?: () => void): void {
        this.state = state;
        this.iterations = iterations;
        this.onDone = onDone || null;
        this.stateStart = performance.now();
    }

    get current(): SpriteState {
        return this.state;
    }

    destroy(): void {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
    }

    private frame = (now: number): void => {
        this.rafId = requestAnimationFrame(this.frame);
        if (!this.sheet) return;

        const def = STATES[this.state];
        const elapsed = now - this.stateStart;
        const cycle = Math.floor(elapsed / def.durationMs);

        if (this.iterations !== "infinite" && cycle >= this.iterations) {
            const done = this.onDone;
            this.set("idle");
            done?.();
            return;
        }

        const t = (elapsed % def.durationMs) / def.durationMs;
        const frame = Math.min(def.frames - 1, Math.floor(t * def.frames));

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(
            this.sheet,
            frame * FRAME_W, def.row * FRAME_H, FRAME_W, FRAME_H,
            0, 0, this.canvas.width, this.canvas.height
        );
    };
}

// ---------------------------------------------------------------------------
// PetLife — the behavior brain.
// ---------------------------------------------------------------------------

export interface PetLifeOptions {
    /** max horizontal wander distance from center, px */
    walkRange: number;
    /** element that receives floating effects */
    effectsEl: HTMLElement;
    /** html (inline svg) floated repeatedly while napping */
    sleepFx: string;
    /** html floated on celebrate() */
    celebrateFx: string;
    /** html floated on oops() */
    oopsFx: string;
    /** called so the host can keep other layers in sync if needed */
    onOffsetChange?: (x: number) => void;
}

const SLEEP_AFTER_MS = 3 * 60_000; // user idle this long -> nap
const WALK_SPEED = 55; // px/s — matches the run animation's cadence

export class PetLife {
    private offsetX = 0;
    private walkRaf = 0;
    private fidgetTimer: ReturnType<typeof setTimeout> | undefined;
    private sleepTimer: ReturnType<typeof setTimeout> | undefined;
    private zzzTimer: ReturnType<typeof setInterval> | undefined;
    private sleeping = false;
    private suspended = false; // panel open / chat in flight
    private removeListeners: () => void;

    constructor(private sprite: PetSprite, private opts: PetLifeOptions) {
        this.scheduleFidget();
        this.armSleepTimer();
        // Any user presence resets the nap clock and wakes the pet.
        const activity = () => this.recordActivity();
        window.addEventListener("mousemove", activity);
        window.addEventListener("mousedown", activity);
        window.addEventListener("keydown", activity);
        this.removeListeners = () => {
            window.removeEventListener("mousemove", activity);
            window.removeEventListener("mousedown", activity);
            window.removeEventListener("keydown", activity);
        };
    }

    /** Pause ambient behavior (e.g., while the panel is open). */
    suspend(): void {
        this.suspended = true;
        this.stopWalk();
        if (this.sleeping) this.wake();
        this.setOffset(0); // slide home so the pet sits under the panel
    }

    resume(): void {
        this.suspended = false;
        this.scheduleFidget();
    }

    /** Icon burst above the pet (hearts on petting, etc.). html = inline svg. */
    emote(html: string, count = 3): void {
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                const el = document.createElement("span");
                el.className = "float-fx";
                el.innerHTML = html;
                el.style.setProperty("--fx-drift", `${(Math.random() - 0.5) * 44}px`);
                el.style.left = `${(Math.random() - 0.5) * 30}px`;
                this.opts.effectsEl.appendChild(el);
                setTimeout(() => el.remove(), 1900);
            }, i * 220);
        }
    }

    celebrate(): void {
        this.stopWalk();
        this.sprite.set("jumping", 2);
        this.emote(this.opts.celebrateFx, 4);
    }

    oops(): void {
        this.stopWalk();
        this.sprite.set("failed", 1);
        this.emote(this.opts.oopsFx, 1);
    }

    destroy(): void {
        clearTimeout(this.fidgetTimer);
        clearTimeout(this.sleepTimer);
        clearInterval(this.zzzTimer);
        this.stopWalk();
        // Without this, a destroyed instance resurrects itself: any mouse move
        // re-arms its sleep timer and it starts posing the shared sprite again.
        this.removeListeners();
    }

    // ------------------------------------------------------------- internals

    private recordActivity(): void {
        if (this.sleeping) this.wake();
        this.armSleepTimer();
    }

    private armSleepTimer(): void {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = setTimeout(() => this.sleep(), SLEEP_AFTER_MS);
    }

    private sleep(): void {
        if (this.suspended || this.sleeping) return;
        this.sleeping = true;
        this.stopWalk();
        this.sprite.set("waiting"); // calmest loop on the sheet = nap pose
        this.zzzTimer = setInterval(() => this.emote(this.opts.sleepFx, 1), 2600);
    }

    private wake(): void {
        this.sleeping = false;
        clearInterval(this.zzzTimer);
        if (this.sprite.current === "waiting") this.sprite.set("idle");
    }

    private scheduleFidget(): void {
        clearTimeout(this.fidgetTimer);
        const delay = 9_000 + Math.random() * 18_000;
        this.fidgetTimer = setTimeout(() => {
            if (!this.suspended && !this.sleeping && this.sprite.current === "idle") {
                const roll = Math.random();
                if (roll < 0.38) this.walkSomewhere();
                else if (roll < 0.58) this.sprite.set("review", 1);
                else if (roll < 0.74) this.sprite.set("waving", 1);
                else if (roll < 0.88) this.sprite.set("running", 1); // busy little burst
                else this.sprite.set("jumping", 1);
            }
            this.scheduleFidget();
        }, delay);
    }

    private walkSomewhere(): void {
        const target = (Math.random() * 2 - 1) * this.opts.walkRange;
        const distance = target - this.offsetX;
        if (Math.abs(distance) < 14) return;
        const dir: SpriteState = distance > 0 ? "running-right" : "running-left";
        this.sprite.set(dir);

        const start = performance.now();
        const from = this.offsetX;
        const durMs = (Math.abs(distance) / WALK_SPEED) * 1000;
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / durMs);
            this.setOffset(from + distance * t);
            if (t < 1 && this.sprite.current === dir) {
                this.walkRaf = requestAnimationFrame(step);
            } else {
                this.walkRaf = 0;
                if (this.sprite.current === dir) this.sprite.set("idle");
            }
        };
        this.walkRaf = requestAnimationFrame(step);
    }

    private stopWalk(): void {
        if (this.walkRaf) cancelAnimationFrame(this.walkRaf);
        this.walkRaf = 0;
        if (this.sprite.current === "running-left" || this.sprite.current === "running-right") {
            this.sprite.set("idle");
        }
    }

    private setOffset(x: number): void {
        this.offsetX = x;
        document.documentElement.style.setProperty("--pet-x", `${Math.round(x)}px`);
        this.opts.onOffsetChange?.(x);
    }
}
