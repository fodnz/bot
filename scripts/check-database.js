import Database from "better-sqlite3";
import { filePath } from "../src/config.js";
import { normalizeIdentifier, normalizePhoneJid } from "../src/database/normalization.js";

const db = new Database(filePath.database, { readonly: true });

try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error(`integrity_check failed: ${integrity?.integrity_check ?? "unknown"}`);

    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`foreign_key_check found ${foreignKeys.length} violation(s)`);

    const malformedPhoneJids = db.prepare("SELECT COUNT(*) AS count FROM group_members WHERE phone_jid IS NOT NULL").get().count;
    const malformedGroupPhones = db.prepare("SELECT COUNT(*) AS count FROM group_event_participants WHERE phone_jid IS NOT NULL").get().count;
    const identityRows = db.prepare("SELECT value FROM contact_identities").all();
    const malformedIdentities = identityRows.reduce((count, row) => count + (normalizeIdentifier(row.value) !== row.value ? 1 : 0), 0);
    const groupRows = db.prepare("SELECT phone_jid FROM group_members WHERE phone_jid IS NOT NULL").all();
    const malformedGroupMembers = groupRows.reduce((count, row) => count + (normalizePhoneJid(row.phone_jid) !== row.phone_jid ? 1 : 0), 0);

    console.log(`integrity_check: ${integrity.integrity_check}`);
    console.log(`foreign_key_check: ${foreignKeys.length === 0 ? "ok" : `${foreignKeys.length} violation(s)`}`);
    console.log(`contact_identities: ${identityRows.length}`);
    console.log(`malformed_contact_identities: ${malformedIdentities}`);
    console.log(`group_member_phone_jids: ${malformedPhoneJids}`);
    console.log(`group_member_malformed_phone_jids: ${malformedGroupMembers}`);
    console.log(`group_event_participant_phone_jids: ${malformedGroupPhones}`);

    if (malformedIdentities || malformedGroupMembers) process.exitCode = 1;
} finally {
    db.close();
}
