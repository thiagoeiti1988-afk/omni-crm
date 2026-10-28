// Backup online e consistente do SQLite (VACUUM INTO não bloqueia leitores).
// Uso: node scripts/backup.mjs [destino]   (default: <db>.backup-<timestamp>)
import { DatabaseSync } from "node:sqlite";

const source = process.env.OMNI_DB_PATH ?? "data/omni-crm.sqlite";
const target = process.argv[2] ?? `${source}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
const check = new DatabaseSync(target, { readOnly: true });
const ok = check.prepare("PRAGMA integrity_check").get();
const orgs = check.prepare("SELECT COUNT(*) AS c FROM organizations").get();
check.close();
console.log(JSON.stringify({ backup: target, integrity: ok.integrity_check, organizations: orgs.c }));
if (ok.integrity_check !== "ok") process.exit(1);
