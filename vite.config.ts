import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Web SPA: iOS 15 / Safari 15+ (see browserslist in package.json). */
const WEB_BUILD_TARGET = ["es2020", "safari15"] as const;

// Two build targets:
//   vite build --mode web     -> dist/web/ (teacher + student, no scanner)
//   vite build --mode scanner -> dist/scanner/ (ScannerPanel only, for Electron)
// Default (no --mode) -> web (development)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
) as { version?: string };

export default defineConfig(({ mode }) => {
  const isScanner = mode === "scanner";
  const buildTarget = isScanner ? "scanner" : "web";
  const scannerOutDir = path.join(__dirname, "dist", "scanner");

  return {
    plugins: [
      react(),
      {
        name: "projectx-scanner-index-html",
        closeBundle() {
          if (!isScanner) return;
          const source = path.join(scannerOutDir, "index-scanner.html");
          const target = path.join(scannerOutDir, "index.html");
          if (fs.existsSync(source)) {
            fs.renameSync(source, target);
          }
        }
      }
    ],
    define: {
      // Compile-time constant so Vite can tree-shake scanner code from web builds
      "import.meta.env.VITE_BUILD_TARGET": JSON.stringify(buildTarget),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version ?? "0.0.0")
    },
    server: {
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:5174",
        "/assets": "http://127.0.0.1:5174"
      }
    },
    build: {
      outDir: isScanner ? scannerOutDir : "dist/web",
      target: isScanner ? undefined : [...WEB_BUILD_TARGET],
      rollupOptions: {
        input: path.resolve(
          __dirname,
          isScanner ? "index-scanner.html" : "index.html"
        )
      }
    }
  };
});
