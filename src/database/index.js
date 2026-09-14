import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { schema, schemaVersion } from "./schema.js";
import { identifierType, normalizeIdentifier, normalizeJid, normalizePhoneJid, normalizePhoneNumber } from "./normalization.js";

const databaseMigrationVersion = 3;

function mergeContact(db, sourceId, targetId) {
    if (sourceId === targetId) return;
    const statements = [
        ["UPDATE chats SET contact_id = ? WHERE contact_id = ?", targetId, sourceId],
        ["UPDATE groups SET owner_contact_id = ? WHERE owner_contact_id = ?", targetId, sourceId],
        ["UPDATE groups SET subject_owner_contact_id = ? WHERE subject_owner_contact_id = ?", targetId, sourceId],
        ["UPDATE group_members SET contact_id = ? WHERE contact_id = ?", targetId, sourceId],
        ["UPDATE messages SET sender_contact_id = ? WHERE sender_contact_id = ?", targetId, sourceId],
        ["UPDATE group_events SET author_contact_id = ? WHERE author_contact_id = ?", targetId, sourceId],
        ["UPDATE group_event_participants SET contact_id = ? WHERE contact_id = ?", targetId, sourceId],
        ["UPDATE group_event_membership_requests SET contact_id = ? WHERE contact_id = ?", targetId, sourceId],
        ["UPDATE group_history_bundles SET sender_contact_id = ? WHERE sender_contact_id = ?", targetId, sourceId]
    ];

    for (const [sql, ...values] of statements) db.prepare(sql).run(...values);
    db.prepare("DELETE FROM contact_identities WHERE contact_id = ?").run(sourceId);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(sourceId);
}

function migrateContactIdentities(db) {
    const rows = db.prepare("SELECT id, contact_id, value FROM contact_identities ORDER BY id").all();
    for (const row of rows) {
        const normalized = normalizeIdentifier(row.value);
        if (!normalized || normalized === row.value) continue;
        const conflict = db.prepare("SELECT id, contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(normalized);
        if (!conflict) {
            db.prepare("UPDATE contact_identities SET value = ?, identifier_type = ?, updated_at = ? WHERE id = ?").run(normalized, identifierType(normalized), Date.now(), row.id);
            continue;
        }
        if (conflict.contact_id === row.contact_id) {
            db.prepare("DELETE FROM contact_identities WHERE id = ?").run(row.id);
            continue;
        }
        mergeContact(db, row.contact_id, conflict.contact_id);
    }
}

function migrateContactPhones(db) {
    const rows = db.prepare("SELECT id, phone_number FROM contacts WHERE phone_number IS NOT NULL").all();
    for (const row of rows) {
        const normalized = normalizePhoneNumber(row.phone_number);
        if (normalized !== row.phone_number) db.prepare("UPDATE contacts SET phone_number = ?, updated_at = ? WHERE id = ?").run(normalized, Date.now(), row.id);
    }
}

function migratePhoneJids(db) {
    const groupMembers = db.prepare("SELECT id, phone_jid FROM group_members WHERE phone_jid IS NOT NULL").all();
    for (const row of groupMembers) {
        const normalized = normalizePhoneJid(row.phone_jid);
        if (normalized !== row.phone_jid) db.prepare("UPDATE group_members SET phone_jid = ?, updated_at = ? WHERE id = ?").run(normalized, Date.now(), row.id);
    }

    const eventParticipants = db.prepare("SELECT id, phone_jid FROM group_event_participants WHERE phone_jid IS NOT NULL").all();
    for (const row of eventParticipants) {
        const normalized = normalizePhoneJid(row.phone_jid);
        if (normalized !== row.phone_jid) db.prepare("UPDATE group_event_participants SET phone_jid = ? WHERE id = ?").run(normalized, row.id);
    }
}

function migrateMessageJids(db) {
    const rows = db.prepare("SELECT id, sender_jid, sender_alt_jid, participant_jid, participant_alt_jid, recipient_jid, recipient_alt_jid FROM messages").all();
    const update = db.prepare("UPDATE messages SET sender_jid = ?, sender_alt_jid = ?, participant_jid = ?, participant_alt_jid = ?, recipient_jid = ?, recipient_alt_jid = ?, updated_at = ? WHERE id = ?");
    for (const row of rows) {
        const previous = [row.sender_jid, row.sender_alt_jid, row.participant_jid, row.participant_alt_jid, row.recipient_jid, row.recipient_alt_jid];
        const values = previous.map((value) => normalizeIdentifier(value));
        if (values.some((value, index) => value !== previous[index])) update.run(...values, Date.now(), row.id);
    }
}

function migrateGroupJids(db) {
    const groups = db.prepare("SELECT id, group_jid, context_group_jid, subject_owner_jid FROM group_events").all();
    const updateEvent = db.prepare("UPDATE group_events SET group_jid = ?, context_group_jid = ?, subject_owner_jid = ? WHERE id = ?");
    for (const row of groups) {
        const values = [normalizeJid(row.group_jid), normalizeJid(row.context_group_jid), normalizeIdentifier(row.subject_owner_jid)];
        if (values[0] !== row.group_jid || values[1] !== row.context_group_jid || values[2] !== row.subject_owner_jid) updateEvent.run(...values, row.id);
    }

    const bundles = db.prepare("SELECT id, group_jid FROM group_history_bundles").all();
    for (const row of bundles) {
        const normalized = normalizeJid(row.group_jid);
        if (normalized !== row.group_jid) db.prepare("UPDATE group_history_bundles SET group_jid = ? WHERE id = ?").run(normalized, row.id);
    }
}

export function initializeDatabase(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new Database(databasePath);

    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");

    try {
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

            if (currentVersion < databaseMigrationVersion) {
                migrateContactIdentities(db);
                migrateContactPhones(db);
                migratePhoneJids(db);
                migrateMessageJids(db);
                migrateGroupJids(db);
            }

            const appliedVersion = Math.max(schemaVersion, databaseMigrationVersion);
            if (currentVersion < appliedVersion) {
                db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(appliedVersion, Date.now());
            }
        });

        migrate();
        const integrity = db.prepare("PRAGMA integrity_check").get();
        if (integrity?.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity?.integrity_check ?? "unknown"}`);
        const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyErrors.length) throw new Error(`SQLite foreign key check failed: ${foreignKeyErrors.length} violation(s)`);
        return db;
    } catch (error) {
        if (db.opened) db.close();
        throw error;
    }
}
