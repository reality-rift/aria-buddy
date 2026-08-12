import { defineConfig } from "vite";

// Tauri expects a fixed dev port and a static build output.
export default defineConfig({
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
    },
    build: {
        target: "safari15",
        outDir: "dist",
    },
});
