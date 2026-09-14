import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { schema, schemaVersion } from "./schema.js";

export function initializeDatabase(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new Database(databasePath);

    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");

    const migrate = db.transaction(() => {
        for (const statement of schema) db.exec(statement);

        const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
        const currentVersion = row?.version ?? 0;

        if (currentVersion < 2) {
            const contactColumns = new Set(db.prepare("PRAGMA table_info(contacts)").all().map((column) => column.name));
            const groupColumns = new Set(db.prepare("PRAGMA table_info(groups)").all().map((column) => column.name));

            if (!contactColumns.has("country_code")) db.exec("ALTER TABLE contacts ADD COLUMN country_code TEXT");

            const columns = {
                no_frequently_forwarded_enabled: "INTEGER CHECK (no_frequently_forwarded_enabled IS NULL OR no_frequently_forwarded_enabled IN (0, 1))",
                support_enabled: "INTEGER CHECK (support_enabled IS NULL OR support_enabled IN (0, 1))",
                suspended: "INTEGER CHECK (suspended IS NULL OR suspended IN (0, 1))",
                incognito: "INTEGER CHECK (incognito IS NULL OR incognito IN (0, 1))",
                allow_admin_reports: "INTEGER CHECK (allow_admin_reports IS NULL OR allow_admin_reports IN (0, 1))",
                auto_add_disabled: "INTEGER CHECK (auto_add_disabled IS NULL OR auto_add_disabled IN (0, 1))",
                group_history_enabled: "INTEGER CHECK (group_history_enabled IS NULL OR group_history_enabled IN (0, 1))",
                capi_enabled: "INTEGER CHECK (capi_enabled IS NULL OR capi_enabled IN (0, 1))",
                group_safety_check: "INTEGER CHECK (group_safety_check IS NULL OR group_safety_check IN (0, 1))"
            };

            for (const [name, definition] of Object.entries(columns)) {
                if (!groupColumns.has(name)) db.exec(`ALTER TABLE groups ADD COLUMN ${name} ${definition}`);
            }
        }

        if (currentVersion < schemaVersion) {
            db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(schemaVersion, Date.now());
        }
    });

    migrate();
    return db;
}
