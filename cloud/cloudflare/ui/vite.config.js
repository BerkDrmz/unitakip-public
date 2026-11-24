import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { demoPlugin } from "./demo-server.js";
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(command === "serve" && process.env.UNITAKIP_UI_DEMO === "1"
      ? [demoPlugin()]
      : []),
  ],
  define: {
    __LOCAL_PREVIEW__: JSON.stringify(
      command === "serve" && process.env.UNITAKIP_UI_DEMO === "1",
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/auth": "http://127.0.0.1:8787",
    },
  },
  // Hiçbir varlık data: URI olarak gömülmez: CSP font-src/img-src yalnızca 'self' izin verir.
  build: { sourcemap: false, chunkSizeWarningLimit: 600, assetsInlineLimit: 0 },
}));
