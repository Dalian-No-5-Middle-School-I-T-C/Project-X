import assert from "node:assert/strict";
import { databaseTimestamp } from "../src/server/db/timestamp";
const value = new Date("2026-09-05T08:00:00.123Z");
assert.equal(databaseTimestamp(value, "sqlite"), value.toISOString());
const encoded = databaseTimestamp(value, "mariadb");
assert.match(encoded, /^2026-09-05 \d{2}:00:00\.123$/);
assert.equal(new Date(encoded.replace(" ", "T")).getTime(), value.getTime());
console.log("PASS database timestamp syntax and local-time round trip", Intl.DateTimeFormat().resolvedOptions().timeZone);
