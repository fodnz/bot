import {
    identifierType,
    normalizeIdentifier,
    normalizeJid,
    normalizePhoneJid,
    normalizePhoneNumber,
    primaryJid,
    uniqueIdentifiers
} from "./normalization.js";

function bool(value) {
    return value === undefined || value === null ? null : value ? 1 : 0;
}

function timestampMs(value) {
    if (value === undefined || value === null) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number > 1e12 ? number : number * 1000;
}

function json(value) {
    return JSON.stringify(value, (_, current) => {
        if (current instanceof Uint8Array) {
            return { type: "Buffer", encoding: "base64", value: Buffer.from(current).toString("base64") };
        }
        return current;
    });
}

function buffer(value) {
    if (value === undefined || value === null) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.from(value);
}

function messageType(message) {
    if (!message || typeof message !== "object") return null;
    return Object.keys(message).find((key) => key !== "messageContextInfo") ?? null;
}

function chatType(jid, key = {}) {
    const normalizedJid = normalizeJid(jid);
    if (key.isGroup || normalizedJid?.endsWith("@g.us")) return "group";
    if (key.isNewsletter || normalizedJid?.endsWith("@newsletter")) return "newsletter";
    if (normalizedJid === "status@broadcast") return "status";
    if (key.isBroadcast || normalizedJid?.endsWith("@broadcast")) return "broadcast";
    if (normalizedJid?.endsWith("@s.whatsapp.net") || normalizedJid?.endsWith("@lid")) return "direct";
    return "other";
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

export function createRepository(db) {
    function ensureContact(input = {}) {
        const identifiers = uniqueIdentifiers([
            input.jid,
            input.lid,
            ...(input.identifiers ?? []),
            input.phoneNumber
        ]);
        const username = input.username ?? null;
        const phoneNumber = normalizePhoneNumber(input.phoneNumber);
        if (username && !identifiers.includes(username)) identifiers.push(username);
        if (!identifiers.length) return null;

        const existingIds = identifiers.map((value) => db.prepare("SELECT contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(value)?.contact_id).filter(Boolean);
        if (phoneNumber) existingIds.push(db.prepare("SELECT id FROM contacts WHERE phone_number = ? LIMIT 1").get(phoneNumber)?.id);
        const id = existingIds.find(Boolean) ?? null;
        const now = Date.now();

        if (!id) {
            const result = db.prepare("INSERT INTO contacts (display_name, push_name, username, phone_number, country_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
                input.displayName ?? null,
                input.pushName ?? null,
                username,
                phoneNumber,
                input.countryCode ?? null,
                now,
                now
            );
            return attachContactIdentifiers(Number(result.lastInsertRowid));
        }

        db.prepare("UPDATE contacts SET display_name = COALESCE(?, display_name), push_name = COALESCE(?, push_name), username = COALESCE(?, username), phone_number = COALESCE(?, phone_number), country_code = COALESCE(?, country_code), updated_at = ? WHERE id = ?").run(
            input.displayName ?? null,
            input.pushName ?? null,
            username,
            phoneNumber,
            input.countryCode ?? null,
            now,
            id
        );
        return attachContactIdentifiers(id);

        function attachContactIdentifiers(contactId) {
            for (const value of identifiers) {
                const normalized = normalizeIdentifier(value);
                if (!normalized) continue;
                const existing = db.prepare("SELECT contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(normalized);
                if (existing && existing.contact_id !== contactId) continue;
                db.prepare("INSERT INTO contact_identities (contact_id, identifier_type, value, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(value) DO UPDATE SET contact_id = excluded.contact_id, identifier_type = excluded.identifier_type, is_primary = CASE WHEN contact_identities.is_primary = 1 THEN 1 ELSE excluded.is_primary END, updated_at = excluded.updated_at").run(
                    contactId,
                    identifierType(normalized),
                    normalized,
                    normalized === identifiers[0] ? 1 : 0,
                    now,
                    now
                );
            }
            return contactId;
        }
    }

    function ensureChat({ jid, type, name, contactId, lastMessageAt = null }) {
        const normalizedJid = normalizeJid(jid);
        if (!normalizedJid) return null;
        const now = Date.now();
        const current = db.prepare("SELECT id FROM chats WHERE jid = ? LIMIT 1").get(normalizedJid);
        if (current) {
            db.prepare("UPDATE chats SET chat_type = COALESCE(?, chat_type), name = COALESCE(?, name), contact_id = COALESCE(?, contact_id), last_message_at = CASE WHEN ? IS NULL THEN last_message_at WHEN last_message_at IS NULL OR ? > last_message_at THEN ? ELSE last_message_at END, updated_at = ? WHERE id = ?").run(type ?? null, name ?? null, contactId ?? null, lastMessageAt, lastMessageAt, lastMessageAt, now, current.id);
            return current.id;
        }
        const result = db.prepare("INSERT INTO chats (jid, chat_type, name, contact_id, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(normalizedJid, type ?? chatType(normalizedJid), name ?? null, contactId ?? null, now, now, lastMessageAt);
        return Number(result.lastInsertRowid);
    }

    function upsertStoredMessage(record) {
        const messageId = record?.id;
        const threadJid = normalizeJid(record?.threadJid);
        if (!messageId || !threadJid) return null;
        const senderJid = normalizeIdentifier(record.senderJid);
        const participantJid = normalizeIdentifier(record.participantJid);
        const senderContactId = senderJid ? ensureContact({ identifiers: [senderJid, participantJid].filter(Boolean) }) : null;
        const chatId = ensureChat({ jid: threadJid, type: chatType(threadJid), lastMessageAt: record.timestampMs ?? null });
        const fromMe = bool(record.fromMe) ?? 0;
        const now = Date.now();
        const existing = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? LIMIT 1").get(chatId, messageId, fromMe);
        if (existing) {
            db.prepare("UPDATE messages SET sender_contact_id = COALESCE(?, sender_contact_id), sender_jid = COALESCE(?, sender_jid), participant_jid = COALESCE(?, participant_jid), timestamp_ms = COALESCE(?, timestamp_ms), raw_message = COALESCE(?, raw_message), updated_at = ? WHERE id = ?").run(senderContactId, senderJid, participantJid, record.timestampMs ?? null, buffer(record.messageBytes), now, existing.id);
            return existing.id;
        }
        const result = db.prepare("INSERT INTO messages (chat_id, message_id, from_me, sender_contact_id, sender_jid, participant_jid, timestamp_ms, message_type, raw_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(chatId, messageId, fromMe, senderContactId, senderJid, participantJid, record.timestampMs ?? null, null, buffer(record.messageBytes), now, now);
        return Number(result.lastInsertRowid);
    }

    function getStoredMessage(id) {
        const row = db.prepare("SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.message_id = ? ORDER BY m.id DESC LIMIT 1").get(id);
        if (!row) return null;
        return { id: row.message_id, threadJid: row.thread_jid, senderJid: row.sender_jid ?? undefined, participantJid: row.participant_jid ?? undefined, fromMe: Boolean(row.from_me), timestampMs: row.timestamp_ms ?? undefined, messageBytes: row.raw_message ? new Uint8Array(row.raw_message) : undefined };
    }

    function listStoredMessages(threadJid, limit = 50, beforeTimestampMs) {
        const normalizedThreadJid = normalizeJid(threadJid);
        if (!normalizedThreadJid) return [];
        const count = Math.max(1, Math.min(Number(limit) || 50, 1000));
        const rows = beforeTimestampMs === undefined
            ? db.prepare("SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.jid = ? ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?").all(normalizedThreadJid, count)
            : db.prepare("SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.jid = ? AND m.timestamp_ms < ? ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?").all(normalizedThreadJid, beforeTimestampMs, count);
        return rows.map((row) => ({ id: row.message_id, threadJid: row.thread_jid, senderJid: row.sender_jid ?? undefined, participantJid: row.participant_jid ?? undefined, fromMe: Boolean(row.from_me), timestampMs: row.timestamp_ms ?? undefined, messageBytes: row.raw_message ? new Uint8Array(row.raw_message) : undefined }));
    }

    function upsertStoredThread(record) {
        const jid = normalizeJid(record?.jid);
        if (!jid) return;
        const chatId = ensureChat({ jid, type: chatType(jid), name: record.name ?? null });
        db.prepare("UPDATE chats SET name = COALESCE(?, name), unread_count = COALESCE(?, unread_count), archived = COALESCE(?, archived), pinned = COALESCE(?, pinned), mute_end_ms = COALESCE(?, mute_end_ms), marked_as_unread = COALESCE(?, marked_as_unread), ephemeral_expiration = COALESCE(?, ephemeral_expiration), ephemeral_setting_timestamp = COALESCE(?, ephemeral_setting_timestamp), updated_at = ? WHERE id = ?").run(record.name ?? null, record.unreadCount ?? null, record.archived === undefined ? null : bool(record.archived), record.pinned ?? null, record.muteEndMs ?? null, record.markedAsUnread === undefined ? null : bool(record.markedAsUnread), record.ephemeralExpiration ?? null, record.ephemeralSettingTimestamp ?? null, Date.now(), chatId);
    }

    function getStoredThread(jid) {
        const normalizedJid = normalizeJid(jid);
        if (!normalizedJid) return null;
        const row = db.prepare("SELECT jid, name, unread_count, archived, pinned, mute_end_ms, marked_as_unread, ephemeral_expiration, ephemeral_setting_timestamp FROM chats WHERE jid = ? LIMIT 1").get(normalizedJid);
        if (!row) return null;
        return { jid: row.jid, name: row.name ?? undefined, unreadCount: row.unread_count ?? undefined, archived: row.archived === null ? undefined : Boolean(row.archived), pinned: row.pinned ?? undefined, muteEndMs: row.mute_end_ms ?? undefined, markedAsUnread: row.marked_as_unread === null ? undefined : Boolean(row.marked_as_unread), ephemeralExpiration: row.ephemeral_expiration ?? undefined, ephemeralSettingTimestamp: row.ephemeral_setting_timestamp ?? undefined };
    }

    function listStoredThreads(limit = 100) {
        const count = Math.max(1, Math.min(Number(limit) || 100, 1000));
        return db.prepare("SELECT jid, name, unread_count, archived, pinned, mute_end_ms, marked_as_unread, ephemeral_expiration, ephemeral_setting_timestamp FROM chats ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT ?").all(count).map((row) => ({ jid: row.jid, name: row.name ?? undefined, unreadCount: row.unread_count ?? undefined, archived: row.archived === null ? undefined : Boolean(row.archived), pinned: row.pinned ?? undefined, muteEndMs: row.mute_end_ms ?? undefined, markedAsUnread: row.marked_as_unread === null ? undefined : Boolean(row.marked_as_unread), ephemeralExpiration: row.ephemeral_expiration ?? undefined, ephemeralSettingTimestamp: row.ephemeral_setting_timestamp ?? undefined }));
    }

    function upsertStoredContact(record) {
        const jid = normalizeIdentifier(record?.jid);
        if (!jid) return;
        ensureContact({ jid, lid: record.lid, displayName: record.displayName, pushName: record.pushName, username: record.username, phoneNumber: record.phoneNumber });
    }

    function getStoredContact(jid) {
        const normalizedJid = normalizeIdentifier(jid);
        if (!normalizedJid) return null;
        const contact = db.prepare("SELECT c.* FROM contacts c JOIN contact_identities ci ON ci.contact_id = c.id WHERE ci.value = ? LIMIT 1").get(normalizedJid);
        if (!contact) return null;
        const primary = db.prepare("SELECT value FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1").get(contact.id)?.value ?? primaryJid(normalizedJid);
        const lid = db.prepare("SELECT value FROM contact_identities WHERE contact_id = ? AND identifier_type = 'lid' LIMIT 1").get(contact.id)?.value;
        return { jid: primary, displayName: contact.display_name ?? undefined, pushName: contact.push_name ?? undefined, lid: lid ?? undefined, phoneNumber: contact.phone_number ?? undefined, username: contact.username ?? undefined, lastUpdatedMs: contact.updated_at };
    }

    function getStoredContactByPhoneNumber(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized) return null;
        const row = db.prepare("SELECT c.id FROM contacts c WHERE c.phone_number = ? LIMIT 1").get(normalized);
        if (!row) return null;
        const primary = db.prepare("SELECT value FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1").get(row.id)?.value;
        return getStoredContact(primary ?? `${normalized}@s.whatsapp.net`);
    }

    function upsertMessage(event, direction = "inbound") {
        const key = event?.key ?? {};
        const messageId = key.id ?? event?.id;
        const chatJid = normalizeJid(key.remoteJid ?? event?.to);
        if (!messageId || !chatJid) return null;
        const timestamp = timestampMs(firstDefined(event.timestampSeconds, event.timestampMs));
        const senderJid = normalizeIdentifier(key.participant ?? key.remoteJid);
        const senderAltJid = normalizeIdentifier(key.participantAlt ?? key.remoteJidAlt);
        const recipientJid = normalizeIdentifier(key.recipientJid);
        const recipientAltJid = normalizeIdentifier(key.recipientAlt);
        const contactId = senderJid ? ensureContact({ identifiers: [senderJid, senderAltJid].filter(Boolean), pushName: event.pushName }) : null;
        const chatId = ensureChat({ jid: chatJid, type: chatType(chatJid, key), contactId, lastMessageAt: timestamp });
        const fromMe = key.fromMe ?? direction === "outbound";
        const now = Date.now();
        const messagePayload = event?.message ?? null;
        const rawMessage = json(messagePayload);
        const current = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? LIMIT 1").get(chatId, messageId, fromMe ? 1 : 0);

        if (current) {
            db.prepare("UPDATE messages SET sender_contact_id = COALESCE(?, sender_contact_id), sender_jid = COALESCE(?, sender_jid), sender_alt_jid = COALESCE(?, sender_alt_jid), participant_jid = COALESCE(?, participant_jid), participant_alt_jid = COALESCE(?, participant_alt_jid), recipient_jid = COALESCE(?, recipient_jid), recipient_alt_jid = COALESCE(?, recipient_alt_jid), push_name = COALESCE(?, push_name), timestamp_ms = COALESCE(?, timestamp_ms), stanza_type = COALESCE(?, stanza_type), message_type = COALESCE(?, message_type), offline = COALESCE(?, offline), expiration_seconds = COALESCE(?, expiration_seconds), raw_message = COALESCE(?, raw_message), raw_event_json = COALESCE(?, raw_event_json), updated_at = ? WHERE id = ?").run(contactId, senderJid, senderAltJid, normalizeIdentifier(key.participant), normalizeIdentifier(key.participantAlt), recipientJid, recipientAltJid, event.pushName ?? null, timestamp, event.stanzaType ?? null, messageType(messagePayload), event.offline === undefined ? null : bool(event.offline), event.expirationSeconds ?? null, buffer(rawMessage), json(event), now, current.id);
            return current.id;
        }

        const result = db.prepare("INSERT INTO messages (chat_id, message_id, from_me, sender_contact_id, sender_jid, sender_alt_jid, participant_jid, participant_alt_jid, recipient_jid, recipient_alt_jid, sender_username, recipient_username, sender_device, server_id, push_name, timestamp_ms, stanza_type, message_type, offline, expiration_seconds, raw_message, raw_event_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(chatId, messageId, fromMe ? 1 : 0, contactId, senderJid, senderAltJid, normalizeIdentifier(key.participant), normalizeIdentifier(key.participantAlt), recipientJid, recipientAltJid, key.senderUsername ?? null, key.recipientUsername ?? null, key.senderDevice ?? null, key.serverId ?? null, event.pushName ?? null, timestamp, event.stanzaType ?? null, messageType(messagePayload), event.offline === undefined ? null : bool(event.offline), event.expirationSeconds ?? null, buffer(rawMessage), json(event), now, now);
        return Number(result.lastInsertRowid);
    }

    function saveReceipt(event) {
        const messageId = event?.id ?? event?.key?.id ?? null;
        const chatJid = normalizeJid(event?.key?.remoteJid ?? event?.remoteJid ?? null);
        const messageRow = messageId ? db.prepare("SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.message_id = ? AND (? IS NULL OR c.jid = ?) ORDER BY m.id DESC LIMIT 1").get(messageId, chatJid, chatJid) : null;
        db.prepare("INSERT INTO message_receipts (message_row_id, message_id, chat_jid, status, from_self_device, participant_jid, participant_username, recipient_jid, occurred_at, raw_event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(messageRow?.id ?? null, messageId ?? "", chatJid, event?.status ?? "unknown", event?.fromSelfDevice ? 1 : 0, normalizeIdentifier(event?.key?.participant ?? event?.participant), event?.key?.participantUsername ?? null, normalizeIdentifier(event?.key?.recipientJid), Date.now(), json(event));
    }

    function saveGenericMessageEvent(type, event) {
        const messageId = event?.id ?? event?.key?.id ?? null;
        const chatJid = normalizeJid(event?.key?.remoteJid ?? event?.remoteJid ?? event?.chatJid ?? null);
        const messageRow = messageId ? db.prepare("SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.message_id = ? AND (? IS NULL OR c.jid = ?) ORDER BY m.id DESC LIMIT 1").get(messageId, chatJid, chatJid) : null;
        const payload = json(event);
        db.prepare("INSERT INTO message_events (message_row_id, event_type, message_id, chat_jid, occurred_at, payload_json, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(messageRow?.id ?? null, type, messageId, chatJid, Date.now(), payload, buffer(payload));
    }

    function upsertGroupMetadata(group) {
        const jid = normalizeJid(group?.id ?? group?.jid ?? group?.groupJid);
        if (!jid) return null;
        const ownerContactId = group.owner ? ensureContact({ identifiers: [group.owner] }) : null;
        const subjectOwnerContactId = group.subjectOwner ? ensureContact({ identifiers: [group.subjectOwner] }) : null;
        const chatId = ensureChat({ jid, type: "group", name: group.subject ?? null });
        const current = db.prepare("SELECT id FROM groups WHERE chat_id = ? LIMIT 1").get(chatId);
        const values = {
            owner_contact_id: ownerContactId,
            subject: group.subject ?? null,
            subject_owner_contact_id: subjectOwnerContactId,
            description: group.description ?? null,
            description_id: group.descriptionId ?? null,
            size: group.size ?? null,
            created_at_ms: timestampMs(group.creation ?? group.createdAt),
            subject_updated_at_ms: timestampMs(group.subjectTime ?? group.subjectUpdatedAt),
            description_updated_at_ms: timestampMs(group.descriptionTime ?? group.descriptionUpdatedAt),
            addressing_mode: group.addressingMode ?? null,
            ephemeral_duration: group.ephemeralDuration ?? null,
            ephemeral_trigger: group.ephemeralTrigger ?? null,
            restrict_enabled: bool(group.restrict),
            announce_enabled: bool(group.announce),
            is_parent_group: bool(group.isParentGroup),
            is_closed_community: bool(group.isClosedCommunity),
            default_subgroup: bool(group.defaultSubgroup),
            general_subgroup: bool(group.generalSubgroup),
            hidden_subgroup: bool(group.hiddenSubgroup),
            allow_non_admin_subgroup_creation: bool(group.allowNonAdminSubgroupCreation),
            limit_sharing_enabled: bool(group.limitSharingEnabled),
            membership_approval_enabled: bool(group.membershipApprovalMode),
            member_add_mode: group.memberAddMode ?? null,
            member_link_mode: group.memberLinkMode ?? null,
            member_share_group_history_mode: group.memberShareGroupHistoryMode ?? null,
            participant_label_enabled: bool(group.participantLabelEnabled),
            evolution_version: group.evolutionVersion ?? null,
            growth_locked_expiration: group.growthLockedExpiration ?? null,
            appeal_status: group.appealStatus ?? null,
            appeal_update_time: timestampMs(group.appealUpdateTime),
            updated_at: Date.now()
        };
        const columns = Object.keys(values);

        if (current) {
            const assignments = columns.map((column) => `${column} = COALESCE(?, ${column})`).join(", ");
            db.prepare(`UPDATE groups SET ${assignments} WHERE id = ?`).run(...columns.map((column) => values[column]), current.id);
        } else {
            const placeholders = columns.map(() => "?").join(", ");
            db.prepare(`INSERT INTO groups (chat_id, ${columns.join(", ")}) VALUES (?, ${placeholders})`).run(chatId, ...columns.map((column) => values[column]));
        }

        const groupId = current?.id ?? db.prepare("SELECT id FROM groups WHERE chat_id = ? LIMIT 1").get(chatId).id;
        const replaceMembers = db.transaction(() => {
            db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
            const insert = db.prepare("INSERT INTO group_members (group_id, contact_id, jid, lid_jid, phone_jid, display_name, username, role, is_admin, is_super_admin, expiration_seconds, active, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            for (const member of group.participants ?? []) {
                const memberJid = normalizeIdentifier(member.jid ?? member.id ?? member.participant);
                const memberLid = normalizeIdentifier(member.lid);
                const phoneJid = normalizePhoneJid(member.phoneNumber ?? member.phoneJid);
                if (!memberJid) continue;
                const contactId = ensureContact({ identifiers: [memberJid, memberLid, phoneJid].filter(Boolean), displayName: member.displayName, username: member.username, phoneNumber: member.phoneNumber ?? member.phoneJid });
                insert.run(groupId, contactId, memberJid, memberLid, phoneJid, member.displayName ?? null, member.username ?? null, member.role ?? null, member.admin ? 1 : 0, member.isSuperAdmin ? 1 : 0, member.expirationSeconds ?? null, 1, member.joinedAt ?? null, Date.now());
            }
        });
        replaceMembers();
        return groupId;
    }

    function persistGroupEvent(event = {}) {
        const jid = normalizeJid(event.groupJid ?? event.jid ?? event.id ?? event.group?.id);
        const groupRow = jid ? db.prepare("SELECT g.id AS group_id FROM groups AS g INNER JOIN chats AS c ON c.id = g.chat_id WHERE c.jid = ? LIMIT 1").get(jid) : null;
        const author = normalizeIdentifier(event.author ?? event.participant ?? event.actor);
        const authorContactId = author ? ensureContact({ identifiers: [author] }) : null;
        const result = db.prepare("INSERT INTO group_events (group_id, action, author_contact_id, group_jid, context_group_jid, timestamp_ms, subject, subject_owner_jid, description, description_id, code, expiration_seconds, mode, enabled, reason, request_method, details_json, raw_event_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(groupRow?.group_id ?? null, event.action ?? event.type ?? "unknown", authorContactId, jid, normalizeJid(event.contextGroupJid), timestampMs(event.timestampMs ?? event.timestampSeconds), event.subject ?? null, normalizeIdentifier(event.subjectOwner), event.description ?? null, event.descriptionId ?? null, event.code ?? null, event.expirationSeconds ?? null, event.mode ?? null, event.enabled === undefined ? null : bool(event.enabled), event.reason ?? null, event.requestMethod ?? null, json(event), json(event), Date.now());
        const eventId = Number(result.lastInsertRowid);
        const insertParticipant = db.prepare("INSERT INTO group_event_participants (group_event_id, contact_id, jid, lid_jid, phone_jid, display_name, username, role, expiration_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const participant of event.participants ?? []) {
            const participantJid = normalizeIdentifier(participant.jid ?? participant.id ?? participant.participant);
            const participantLid = normalizeIdentifier(participant.lid);
            const participantPhoneJid = normalizePhoneJid(participant.phoneJid ?? participant.phoneNumber);
            const contactId = participantJid ? ensureContact({ identifiers: [participantJid, participantLid, participantPhoneJid].filter(Boolean), displayName: participant.displayName, username: participant.username, phoneNumber: participant.phoneJid ?? participant.phoneNumber }) : null;
            insertParticipant.run(eventId, contactId, participantJid, participantLid, participantPhoneJid, participant.displayName ?? null, participant.username ?? null, participant.role ?? null, participant.expirationSeconds ?? null);
        }
        return eventId;
    }

    function saveHistoryChunk(event = {}) {
        db.prepare("INSERT INTO history_sync_chunks (sync_type, messages_count, conversations_count, pushnames_count, inline_contacts_count, chunk_order, progress, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(Number(event.syncType ?? 0), Number(event.messagesCount ?? event.messageCount ?? 0), Number(event.conversationsCount ?? event.conversationCount ?? 0), Number(event.pushnamesCount ?? event.pushNamesCount ?? 0), Number(event.inlineContactsCount ?? event.inlineContactCount ?? 0), event.chunkOrder ?? event.order ?? null, event.progress ?? null, Date.now());
    }

    function saveGroupHistoryBundle(event = {}) {
        const jid = normalizeJid(event.groupJid ?? event.jid);
        if (!jid) return null;
        const chatId = ensureChat({ jid, type: "group" });
        const senderJid = normalizeIdentifier(event.senderJid ?? event.sender);
        const senderContactId = senderJid ? ensureContact({ identifiers: [senderJid] }) : null;
        db.prepare("INSERT INTO group_history_bundles (group_chat_id, group_jid, sender_contact_id, bundle_message_id, messages_count, out_of_window_pins_count, dropped_count, oldest_timestamp_ms, history_receivers_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(chatId, jid, senderContactId, event.messageId ?? event.bundleMessageId ?? null, Number(event.messagesCount ?? 0), Number(event.outOfWindowPinsCount ?? 0), Number(event.droppedCount ?? 0), timestampMs(event.oldestTimestampMs ?? event.oldestTimestamp), json(event.historyReceivers ?? event.historyReceiversJids ?? []), Date.now());
        return chatId;
    }

    function deleteStoredMessage(id) {
        return db.prepare("DELETE FROM messages WHERE message_id = ?").run(id).changes;
    }

    function clearStoredMessages() {
        return db.prepare("DELETE FROM messages").run().changes;
    }

    function deleteStoredThread(jid) {
        const normalizedJid = normalizeJid(jid);
        return normalizedJid ? db.prepare("DELETE FROM chats WHERE jid = ?").run(normalizedJid).changes : 0;
    }

    function clearStoredThreads() {
        return db.prepare("DELETE FROM chats").run().changes;
    }

    function deleteStoredContact(jid) {
        const normalizedJid = normalizeIdentifier(jid);
        if (!normalizedJid) return 0;
        const row = db.prepare("SELECT contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(normalizedJid);
        return row ? db.prepare("DELETE FROM contacts WHERE id = ?").run(row.contact_id).changes : 0;
    }

    function clearStoredContacts() {
        return db.prepare("DELETE FROM contacts").run().changes;
    }

    return {
        ensureContact,
        ensureChat,
        upsertStoredMessage,
        getStoredMessage,
        listStoredMessages,
        deleteStoredMessage,
        clearStoredMessages,
        upsertStoredThread,
        getStoredThread,
        listStoredThreads,
        deleteStoredThread,
        clearStoredThreads,
        upsertStoredContact,
        getStoredContact,
        getStoredContactByPhoneNumber,
        deleteStoredContact,
        clearStoredContacts,
        upsertMessage,
        saveReceipt,
        persistGroupEvent,
        upsertGroupMetadata,
        saveHistoryChunk,
        saveGroupHistoryBundle,
        saveGenericMessageEvent
    };
}
