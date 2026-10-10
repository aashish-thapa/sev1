import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// Matches --color-paper / --color-accent in src/styles/tokens.css (manifest needs hex).
const PAPER_HEX = "#100d09";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "sev1 — production incidents, one swipe at a time",
        short_name: "sev1",
        description: "A daily shift of real production failure modes. Read the alert, make the call.",
        theme_color: PAPER_HEX,
        background_color: PAPER_HEX,
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // The 3D hall is ~1 MB; fetch it the first time someone walks the floor, not on install.
        // People, props and surfaces (~25 MB) load when the office opens and are cached as they arrive.
        globIgnores: ["**/FloorView-*.js", "office/**"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/office/"),
            handler: "CacheFirst",
            options: { cacheName: "office-assets", expiration: { maxEntries: 80 } },
          },
          {
            urlPattern: ({ url }) => /\/assets\/FloorView-.*\.js$/.test(url.pathname),
            handler: "CacheFirst",
            options: { cacheName: "floor-3d", expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
  server: {
    // Rooms ride the same origin as the app, so one tunnel/port serves both.
    proxy: {
      "/rooms": { target: "ws://localhost:8787", ws: true },
      // Listed before /api so the public room list comes from the room server, not the worker.
      "/api/rooms": { target: "http://localhost:8787" },
      // Accounts run in the worker: `pnpm dev:worker`. Without it the lobby reports the account server as unreachable.
      "/api": { target: "http://localhost:8790" },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
