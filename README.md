# Aria Buddy

A tiny HelloAria companion that lives on your desktop — outside the browser,
on top of everything. Pick a pet, name it, and it carries your day with it:

- **Tap the pet** → today's schedule, todos (complete them right there), and
  upcoming reminders in a clean quick-view panel.
- **Chat with Aria** from the panel — replies appear in the pet's speech
  bubble above its head.
- **Reminders land on your desktop**: when one comes due, the pet waves and
  shows it — no browser or notification permissions involved.
- **Drag it anywhere.** It idles, waves, celebrates your completed todos.

Built with Tauri, so the installer is a few megabytes — not an Electron app.

## Connect

The app talks to the HelloAria public API (`api.ductivity.in/v1`). On first
launch, paste an API key from the dashboard: **Settings → Developer → Create
key**. That's the whole setup.

## Pets

Sprites use the [OpenPets](https://github.com/alvinunreal/openpets)
universal spritesheet format (MIT): 192×208 frames, 8 columns × 9 animation
rows (idle, run, wave, jump, fail, wait, work, review). Bundled pets are the
OpenPets default creature and Tux. Any spritesheet in the same format drops
into `src/pets/<id>/spritesheet.webp` + one entry in `src/state.ts`.

> Note: some community pet packs depict trademarked characters (Snoopy,
> Clippy, Wall-E…). Do NOT bundle those in official HelloAria builds.

## Develop

```bash
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # local installer for this OS
```

Requires Rust (rustup) + Node 20. Windows installers are produced by the
GitHub Actions matrix in `.github/workflows/build.yml` — push a `v*` tag and
a draft release appears with the `.dmg` and `.exe`. Set the `APPLE_*` repo
secrets before public releases so macOS builds are signed + notarized.
