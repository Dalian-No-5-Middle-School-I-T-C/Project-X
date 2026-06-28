import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two build targets:
//   vite build --mode web     → dist/web/   (teacher + student, no scanner)
//   vite build --mode scanner → dist/scanner/ (ScannerPanel only, for Electron)
// Default (no --mode) → web (development)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const isScanner = mode === "scanner";
  const buildTarget = isScanner ? "scanner" : "web";

  return {
    plugins: [react()],
    define: {
      // Compile-time constant so Vite can tree-shake scanner code from web builds
      "import.meta.env.VITE_BUILD_TARGET": JSON.stringify(buildTarget)
    },
    server: {
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:5174",
        "/assets": "http://127.0.0.1:5174"
      }
    },
    build: {
      outDir: isScanner ? "dist/scanner" : "dist/web",
      rollupOptions: {
        input: path.resolve(
          __dirname,
          isScanner ? "index-scanner.html" : "index.html"
        )
      }
    }
  };
});
