import { createRepository as createLegacyRepository } from "./repository.js";

function json(value) {
    return JSON.stringify(value, (_, current) => {
        if (current instanceof Uint8Array) {
            return { type: "Buffer", encoding: "base64", value: Buffer.from(current).toString("base64") };
        }
        return current;
    });
}

function toBoolean(value) {
    return value === undefined || value === null ? null : value ? 1 : 0;
}

function timestampMs(value) {
    if (value === undefined || value === null) return null;
    const number = Number(value);
    return number > 1e12 ? number : number * 1000;
}

function createGroupEventPersistence(db, repository) {
    return function persistGroupEvent(event = {}) {
        const jid = event.groupJid ?? event.jid ?? event.id ?? event.group?.id ?? null;
        const groupRow = jid
            ? db.prepare("SELECT g.id AS group_id FROM groups AS g INNER JOIN chats AS c ON c.id = g.chat_id WHERE c.jid = ? LIMIT 1").get(jid)
            : null;
        const groupId = groupRow?.group_id ?? null;
        const author = event.author ?? event.participant ?? event.actor ?? null;
        const authorContactId = author ? repository.ensureContact({ identifiers: [author] }) : null;
        const insertEvent = db.prepare(`
            INSERT INTO group_events (
                group_id, action, author_contact_id, group_jid, context_group_jid,
                timestamp_ms, subject, subject_owner_jid, description, description_id,
                code, expiration_seconds, mode, enabled, reason, request_method,
                details_json, raw_event_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = insertEvent.run(
            groupId,
            event.action ?? event.type ?? "unknown",
            authorContactId,
            jid,
            event.contextGroupJid ?? null,
            timestampMs(event.timestampMs ?? event.timestampSeconds),
            event.subject ?? null,
            event.subjectOwner ?? null,
            event.description ?? null,
            event.descriptionId ?? null,
            event.code ?? null,
            event.expirationSeconds ?? null,
            event.mode ?? null,
            event.enabled === undefined ? null : toBoolean(event.enabled),
            event.reason ?? null,
            event.requestMethod ?? null,
            json(event),
            json(event),
            Date.now()
        );
        const eventId = Number(result.lastInsertRowid);
        const insertParticipant = db.prepare(`
            INSERT INTO group_event_participants (
                group_event_id, contact_id, jid, lid_jid, phone_jid,
                display_name, username, role, expiration_seconds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const participant of event.participants ?? []) {
            const participantJid = participant.jid ?? participant.id ?? participant.participant ?? null;
            const contactId = participantJid
                ? repository.ensureContact({
                    identifiers: [participantJid, participant.lid].filter(Boolean),
                    displayName: participant.displayName,
                    username: participant.username
                })
                : null;
            insertParticipant.run(
                eventId,
                contactId,
                participantJid,
                participant.lid ?? null,
                participant.phoneJid ?? null,
                participant.displayName ?? null,
                participant.username ?? null,
                participant.role ?? null,
                participant.expirationSeconds ?? null
            );
        }
        return eventId;
    };
}

export function createRepository(db) {
    const repository = createLegacyRepository(db);
    repository.persistGroupEvent = createGroupEventPersistence(db, repository);
    return repository;
}
