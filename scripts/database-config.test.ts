import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getMariadbConfig } from "../src/server/db/mysql";

test("config.yml uses the MariaDB default port and honors an explicit port", () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "px-db-config-"));
  const keys = ["PROJECTX_MARIADB_HOST", "PROJECTX_MYSQL_HOST"];
  const hosts = keys.map(key => process.env[key]);
  try {
    process.chdir(dir);
    for (const key of keys) delete process.env[key];
    const remote = "database:\n  mode: remote\n  remote:\n    host: db.example.test\n";
    writeFileSync("config.yml", remote);
    assert.equal(getMariadbConfig()?.port, 3306);
    writeFileSync("config.yml", remote + "    port: 13306\n");
    assert.equal(getMariadbConfig()?.port, 13306);
  } finally {
    process.chdir(cwd);
    keys.forEach((key, i) => {
      if (hosts[i] === undefined) delete process.env[key];
      else process.env[key] = hosts[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
