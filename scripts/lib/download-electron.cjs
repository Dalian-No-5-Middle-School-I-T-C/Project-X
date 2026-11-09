const { createRequire } = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");

const fromElectron = createRequire(require.resolve("electron/package.json"));
const { version } = fromElectron("./package.json");
const checksums = fromElectron("./checksums.json");
const { downloadArtifact, initializeProxy } = fromElectron("@electron/get");
const proxyVariables = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
if (!process.env.ELECTRON_GET_USE_PROXY && proxyVariables.some((name) => process.env[name]?.trim())) {
  initializeProxy();
}

const retryableNetworkErrors = new Set([
  "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

async function downloadElectronZip({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = process.env.electron_config_cache,
  expectedVersion = version,
} = {}) {
  if (version !== expectedVersion) {
    throw new Error(`Installed Electron ${version} does not match locked version ${expectedVersion}`);
  }

  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(600_000);
    try {
      return await downloadArtifact({
        version, artifactName: "electron", platform, arch, cacheRoot, checksums,
        downloadOptions: { signal },
      });
    } catch (error) {
      const status = error.response?.status;
      const code = error.cause?.code ?? error.code;
      const temporary = status === 408 || status === 429 || (status >= 500 && status < 600)
        || (signal.aborted && (error.name === "TimeoutError" || error.name === "AbortError"))
        || retryableNetworkErrors.has(code);
      if (!temporary || attempt === 3) throw error;
      console.warn(`Electron ${version} ${platform}/${arch} download failed (attempt ${attempt}/3): ${error.message}`);
      await delay(attempt * 2_000);
    }
  }
}

module.exports = { downloadElectronZip };

if (require.main === module) {
  downloadElectronZip().then(console.log, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
