function bool(value) {
    return value === undefined || value === null ? null : value ? 1 : 0;
}

function timestampMs(value) {
    if (value === undefined || value === null) return null;
    return Number(value) > 1e12 ? Number(value) : Number(value) * 1000;
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

function jidType(value) {
    if (!value) return "jid";
    if (value.endsWith("@lid")) return "lid";
    if (value.endsWith("@s.whatsapp.net")) return "pn";
    if (value.includes(":") && value.includes("@")) return "device_jid";
    return "jid";
}

function messageType(message) {
    if (!message || typeof message !== "object") return null;
    return Object.keys(message).find((key) => key !== "messageContextInfo") ?? null;
}

function chatType(jid, key = {}) {
    if (key.isGroup || jid?.endsWith("@g.us")) return "group";
    if (key.isNewsletter || jid?.endsWith("@newsletter")) return "newsletter";
    if (jid === "status@broadcast") return "status";
    if (key.isBroadcast || jid?.endsWith("@broadcast")) return "broadcast";
    if (jid?.endsWith("@s.whatsapp.net") || jid?.endsWith("@lid")) return "direct";
    return "other";
}

function primaryJid(value) {
    if (typeof value !== "string") return null;
    const separator = value.indexOf(":");
    const at = value.indexOf("@");
    return separator >= 0 && at > separator ? `${value.slice(0, separator)}${value.slice(at)}` : value;
}

export function createRepository(db) {
    function ensureContact(input = {}) {
        const identifiers = [input.jid, input.lid, ...(input.identifiers ?? [])].filter(Boolean);
        const username = input.username ?? null;
        const phoneNumber = input.phoneNumber ?? null;
        if (username) identifiers.push(username);
        if (phoneNumber) identifiers.push(phoneNumber);
        const existing = identifiers
            .map((value) => db.prepare("SELECT contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(value)?.contact_id)
            .find(Boolean);
        const now = Date.now();
        let id = existing;

        if (!id) {
            const result = db.prepare(`INSERT INTO contacts (display_name, push_name, username, phone_number, country_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
                input.displayName ?? null,
                input.pushName ?? null,
                username,
                phoneNumber,
                input.countryCode ?? null,
                now,
                now
            );
            id = Number(result.lastInsertRowid);
        } else {
            db.prepare(`UPDATE contacts SET display_name = COALESCE(?, display_name), push_name = COALESCE(?, push_name), username = COALESCE(?, username), phone_number = COALESCE(?, phone_number), country_code = COALESCE(?, country_code), updated_at = ? WHERE id = ?`).run(
                input.displayName ?? null,
                input.pushName ?? null,
                username,
                phoneNumber,
                input.countryCode ?? null,
                now,
                id
            );
        }

        for (const value of [...new Set(identifiers)]) {
            db.prepare(`INSERT INTO contact_identities (contact_id, identifier_type, value, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(value) DO UPDATE SET contact_id = excluded.contact_id, identifier_type = excluded.identifier_type, updated_at = excluded.updated_at`).run(
                id,
                jidType(value),
                value,
                value === identifiers[0] ? 1 : 0,
                now,
                now
            );
        }

        return id;
    }

    function ensureChat({ jid, type, name, contactId, lastMessageAt = null }) {
        if (!jid) return null;
        const now = Date.now();
        const current = db.prepare("SELECT id FROM chats WHERE jid = ? LIMIT 1").get(jid);
        if (current) {
            db.prepare(`UPDATE chats SET chat_type = COALESCE(?, chat_type), name = COALESCE(?, name), contact_id = COALESCE(?, contact_id), last_message_at = CASE WHEN ? IS NULL THEN last_message_at WHEN last_message_at IS NULL OR ? > last_message_at THEN ? ELSE last_message_at END, updated_at = ? WHERE id = ?`).run(type ?? null, name ?? null, contactId ?? null, lastMessageAt, lastMessageAt, lastMessageAt, now, current.id);
            return current.id;
        }
        const result = db.prepare(`INSERT INTO chats (jid, chat_type, name, contact_id, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jid, type ?? "other", name ?? null, contactId ?? null, now, now, lastMessageAt);
        return Number(result.lastInsertRowid);
    }

    function upsertStoredMessage(record) {
        if (!record?.id || !record?.threadJid) return;
        const chatId = ensureChat({ jid: record.threadJid, type: chatType(record.threadJid), lastMessageAt: record.timestampMs ?? null });
        const senderContactId = record.senderJid ? ensureContact({ identifiers: [record.senderJid, record.participantJid].filter(Boolean) }) : null;
        const now = Date.now();
        const existing = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? LIMIT 1").get(chatId, record.id, bool(record.fromMe) ?? 0);
        if (existing) {
            db.prepare(`UPDATE messages SET sender_contact_id = COALESCE(?, sender_contact_id), sender_jid = COALESCE(?, sender_jid), participant_jid = COALESCE(?, participant_jid), timestamp_ms = COALESCE(?, timestamp_ms), raw_message = COALESCE(?, raw_message), updated_at = ? WHERE id = ?`).run(senderContactId, record.senderJid ?? null, record.participantJid ?? null, record.timestampMs ?? null, buffer(record.messageBytes), now, existing.id);
            return existing.id;
        }
        const result = db.prepare(`INSERT INTO messages (chat_id, message_id, from_me, sender_contact_id, sender_jid, participant_jid, timestamp_ms, message_type, raw_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            chatId,
            record.id,
            record.fromMe ? 1 : 0,
            senderContactId,
            record.senderJid ?? null,
            record.participantJid ?? null,
            record.timestampMs ?? null,
            null,
            buffer(record.messageBytes),
            now,
            now
        );
        return Number(result.lastInsertRowid);
    }

    function getStoredMessage(id) {
        const row = db.prepare(`SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.message_id = ? ORDER BY m.id DESC LIMIT 1`).get(id);
        if (!row) return null;
        return {
            id: row.message_id,
            threadJid: row.thread_jid,
            senderJid: row.sender_jid ?? undefined,
            participantJid: row.participant_jid ?? undefined,
            fromMe: Boolean(row.from_me),
            timestampMs: row.timestamp_ms ?? undefined,
            messageBytes: row.raw_message ? new Uint8Array(row.raw_message) : undefined
        };
    }

    function listStoredMessages(threadJid, limit = 50, beforeTimestampMs) {
        const count = Math.max(1, Math.min(Number(limit) || 50, 1000));
        const rows = beforeTimestampMs === undefined
            ? db.prepare(`SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.jid = ? ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?`).all(threadJid, count)
            : db.prepare(`SELECT m.message_id, c.jid AS thread_jid, m.sender_jid, m.participant_jid, m.from_me, m.timestamp_ms, m.raw_message FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.jid = ? AND m.timestamp_ms < ? ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?`).all(threadJid, beforeTimestampMs, count);
        return rows.map((row) => ({ id: row.message_id, threadJid: row.thread_jid, senderJid: row.sender_jid ?? undefined, participantJid: row.participant_jid ?? undefined, fromMe: Boolean(row.from_me), timestampMs: row.timestamp_ms ?? undefined, messageBytes: row.raw_message ? new Uint8Array(row.raw_message) : undefined }));
    }

    function upsertStoredThread(record) {
        if (!record?.jid) return;
        const chatId = ensureChat({ jid: record.jid, type: chatType(record.jid), name: record.name ?? null });
        db.prepare(`UPDATE chats SET name = COALESCE(?, name), unread_count = COALESCE(?, unread_count), archived = COALESCE(?, archived), pinned = COALESCE(?, pinned), mute_end_ms = COALESCE(?, mute_end_ms), marked_as_unread = COALESCE(?, marked_as_unread), ephemeral_expiration = COALESCE(?, ephemeral_expiration), ephemeral_setting_timestamp = COALESCE(?, ephemeral_setting_timestamp), updated_at = ? WHERE id = ?`).run(record.name ?? null, record.unreadCount ?? null, record.archived === undefined ? null : bool(record.archived), record.pinned ?? null, record.muteEndMs ?? null, record.markedAsUnread === undefined ? null : bool(record.markedAsUnread), record.ephemeralExpiration ?? null, record.ephemeralSettingTimestamp ?? null, Date.now(), chatId);
    }

    function getStoredThread(jid) {
        const row = db.prepare(`SELECT jid, name, unread_count, archived, pinned, mute_end_ms, marked_as_unread, ephemeral_expiration, ephemeral_setting_timestamp FROM chats WHERE jid = ? LIMIT 1`).get(jid);
        if (!row) return null;
        return { jid: row.jid, name: row.name ?? undefined, unreadCount: row.unread_count ?? undefined, archived: row.archived === null ? undefined : Boolean(row.archived), pinned: row.pinned ?? undefined, muteEndMs: row.mute_end_ms ?? undefined, markedAsUnread: row.marked_as_unread === null ? undefined : Boolean(row.marked_as_unread), ephemeralExpiration: row.ephemeral_expiration ?? undefined, ephemeralSettingTimestamp: row.ephemeral_setting_timestamp ?? undefined };
    }

    function listStoredThreads(limit = 100) {
        const count = Math.max(1, Math.min(Number(limit) || 100, 1000));
        return db.prepare(`SELECT jid, name, unread_count, archived, pinned, mute_end_ms, marked_as_unread, ephemeral_expiration, ephemeral_setting_timestamp FROM chats ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT ?`).all(count).map((row) => ({ jid: row.jid, name: row.name ?? undefined, unreadCount: row.unread_count ?? undefined, archived: row.archived === null ? undefined : Boolean(row.archived), pinned: row.pinned ?? undefined, muteEndMs: row.mute_end_ms ?? undefined, markedAsUnread: row.marked_as_unread === null ? undefined : Boolean(row.marked_as_unread), ephemeralExpiration: row.ephemeral_expiration ?? undefined, ephemeralSettingTimestamp: row.ephemeral_setting_timestamp ?? undefined }));
    }

    function upsertStoredContact(record) {
        if (!record?.jid) return;
        ensureContact({ identifiers: [record.jid, record.lid].filter(Boolean), displayName: record.displayName, pushName: record.pushName, username: record.username, phoneNumber: record.phoneNumber });
    }

    function getStoredContact(jid) {
        const contact = db.prepare(`SELECT c.* FROM contacts c JOIN contact_identities ci ON ci.contact_id = c.id WHERE ci.value = ? LIMIT 1`).get(jid);
        if (!contact) return null;
        const primary = db.prepare(`SELECT value FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1`).get(contact.id)?.value ?? primaryJid(jid);
        const lid = db.prepare(`SELECT value FROM contact_identities WHERE contact_id = ? AND identifier_type = 'lid' LIMIT 1`).get(contact.id)?.value;
        return { jid: primary, displayName: contact.display_name ?? undefined, pushName: contact.push_name ?? undefined, lid: lid ?? undefined, phoneNumber: contact.phone_number ?? undefined, username: contact.username ?? undefined, lastUpdatedMs: contact.updated_at };
    }

    function getStoredContactByPhoneNumber(phoneNumber) {
        const row = db.prepare("SELECT c.* FROM contacts c WHERE c.phone_number = ? LIMIT 1").get(phoneNumber);
        return row ? getStoredContact(db.prepare("SELECT value FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1").get(row.id)?.value ?? phoneNumber) : null;
    }

    function upsertMessage(event, direction = "inbound") {
        const key = event?.key ?? {};
        const messageId = key.id ?? event?.id;
        const chatJid = key.remoteJid ?? event?.to;
        if (!messageId || !chatJid) return null;
        const timestamp = timestampMs(event.timestampSeconds ?? event.timestampMs);
        const senderJid = key.participant ?? key.remoteJid ?? null;
        const senderAltJid = key.participantAlt ?? key.remoteJidAlt ?? null;
        const contactId = senderJid ? ensureContact({ identifiers: [senderJid, senderAltJid].filter(Boolean), pushName: event.pushName }) : null;
        const chatId = ensureChat({ jid: chatJid, type: chatType(chatJid, key), contactId, lastMessageAt: timestamp });
        const fromMe = key.fromMe ?? direction === "outbound";
        const now = Date.now();
        const raw = json(event?.message ?? null);
        const current = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? LIMIT 1").get(chatId, messageId, fromMe ? 1 : 0);
        if (current) {
            db.prepare(`UPDATE messages SET sender_contact_id = COALESCE(?, sender_contact_id), sender_jid = COALESCE(?, sender_jid), sender_alt_jid = COALESCE(?, sender_alt_jid), participant_jid = COALESCE(?, participant_jid), recipient_jid = COALESCE(?, recipient_jid), recipient_alt_jid = COALESCE(?, recipient_alt_jid), push_name = COALESCE(?, push_name), timestamp_ms = COALESCE(?, timestamp_ms), stanza_type = COALESCE(?, stanza_type), message_type = COALESCE(?, message_type), offline = COALESCE(?, offline), expiration_seconds = COALESCE(?, expiration_seconds), raw_event_json = COALESCE(?, raw_event_json), updated_at = ? WHERE id = ?`).run(contactId, senderJid, senderAltJid, key.participant ?? null, key.recipientJid ?? null, key.recipientAlt ?? null, event.pushName ?? null, timestamp, event.stanzaType ?? null, messageType(event.message), event.offline === undefined ? null : bool(event.offline), event.expirationSeconds ?? null, json(event), now, current.id);
            return current.id;
        }
        const result = db.prepare(`INSERT INTO messages (chat_id, message_id, from_me, sender_contact_id, sender_jid, sender_alt_jid, participant_jid, participant_alt_jid, recipient_jid, recipient_alt_jid, sender_username, recipient_username, sender_device, server_id, push_name, timestamp_ms, stanza_type, message_type, offline, expiration_seconds, raw_event_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chatId, messageId, fromMe ? 1 : 0, contactId, senderJid, senderAltJid, key.participant ?? null, key.participantAlt ?? null, key.recipientJid ?? null, key.recipientAlt ?? null, key.senderUsername ?? null, key.recipientUsername ?? null, key.senderDevice ?? null, key.serverId ?? null, event.pushName ?? null, timestamp, event.stanzaType ?? null, messageType(event.message), event.offline === undefined ? null : bool(event.offline), event.expirationSeconds ?? null, json(event), now, now);
        if (raw) db.prepare("UPDATE messages SET raw_message = COALESCE(raw_message, ?) WHERE id = ?").run(Buffer.from(raw), result.lastInsertRowid);
        return Number(result.lastInsertRowid);
    }

    function saveReceipt(event) {
        const messageId = event?.id ?? event?.key?.id;
        db.prepare(`INSERT INTO message_receipts (message_row_id, message_id, chat_jid, status, from_self_device, participant_jid, participant_username, recipient_jid, occurred_at, raw_event_json) VALUES ((SELECT id FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(messageId ?? "", messageId ?? "", event?.key?.remoteJid ?? event?.remoteJid ?? null, event?.status ?? "unknown", event?.fromSelfDevice ? 1 : 0, event?.key?.participant ?? event?.participant ?? null, event?.key?.participantUsername ?? null, event?.key?.recipientJid ?? null, Date.now(), json(event));
    }

    function saveGenericMessageEvent(type, event) {
        db.prepare(`INSERT INTO message_events (message_row_id, event_type, message_id, chat_jid, occurred_at, payload_json, raw_payload) VALUES ((SELECT id FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, ?, ?)`).run(event?.id ?? event?.key?.id ?? null, type, event?.id ?? event?.key?.id ?? null, event?.key?.remoteJid ?? event?.remoteJid ?? event?.chatJid ?? null, Date.now(), json(event), Buffer.from(json(event) ?? "null"));
    }

    function upsertGroupMetadata(group) {
        const jid = group?.id ?? group?.jid ?? group?.groupJid;
        if (!jid) return null;
        const ownerContactId = group.owner ? ensureContact({ identifiers: [group.owner] }) : null;
        const subjectOwnerContactId = group.subjectOwner ? ensureContact({ identifiers: [group.subjectOwner] }) : null;
        const chatId = ensureChat({ jid, type: "group", name: group.subject ?? null });
        const current = db.prepare("SELECT id FROM groups WHERE chat_id = ? LIMIT 1").get(chatId);
        const values = [
            ownerContactId, group.subject ?? null, subjectOwnerContactId, group.description ?? null, group.descriptionId ?? null, group.size ?? null,
            timestampMs(group.creation ?? group.createdAt), timestampMs(group.subjectTime ?? group.subjectUpdatedAt), timestampMs(group.descriptionTime ?? group.descriptionUpdatedAt),
            group.addressingMode ?? null, group.ephemeralDuration ?? null, group.ephemeralTrigger ?? null, bool(group.restrict), bool(group.announce), bool(group.isParentGroup), bool(group.isClosedCommunity), bool(group.defaultSubgroup), bool(group.generalSubgroup), bool(group.hiddenSubgroup), bool(group.allowNonAdminSubgroupCreation), bool(group.limitSharingEnabled), bool(group.membershipApprovalMode), group.memberAddMode ?? null, group.memberLinkMode ?? null, group.memberShareGroupHistoryMode ?? null, bool(group.participantLabelEnabled), group.evolutionVersion ?? null, group.growthLockedExpiration ?? null, group.appealStatus ?? null, group.appealUpdateTime ?? null,
            Date.now()
        ];
        if (current) {
            db.prepare(`UPDATE groups SET owner_contact_id = COALESCE(?, owner_contact_id), subject = COALESCE(?, subject), subject_owner_contact_id = COALESCE(?, subject_owner_contact_id), description = COALESCE(?, description), description_id = COALESCE(?, description_id), size = COALESCE(?, size), created_at_ms = COALESCE(?, created_at_ms), subject_updated_at_ms = COALESCE(?, subject_updated_at_ms), description_updated_at_ms = COALESCE(?, description_updated_at_ms), addressing_mode = COALESCE(?, addressing_mode), ephemeral_duration = COALESCE(?, ephemeral_duration), ephemeral_trigger = COALESCE(?, ephemeral_trigger), restrict_enabled = COALESCE(?, restrict_enabled), announce_enabled = COALESCE(?, announce_enabled), is_parent_group = COALESCE(?, is_parent_group), is_closed_community = COALESCE(?, is_closed_community), default_subgroup = COALESCE(?, default_subgroup), general_subgroup = COALESCE(?, general_subgroup), hidden_subgroup = COALESCE(?, hidden_subgroup), allow_non_admin_subgroup_creation = COALESCE(?, allow_non_admin_subgroup_creation), limit_sharing_enabled = COALESCE(?, limit_sharing_enabled), membership_approval_enabled = COALESCE(?, membership_approval_enabled), member_add_mode = COALESCE(?, member_add_mode), member_link_mode = COALESCE(?, member_link_mode), member_share_group_history_mode = COALESCE(?, member_share_group_history_mode), participant_label_enabled = COALESCE(?, participant_label_enabled), evolution_version = COALESCE(?, evolution_version), growth_locked_expiration = COALESCE(?, growth_locked_expiration), appeal_status = COALESCE(?, appeal_status), appeal_update_time = COALESCE(?, appeal_update_time), updated_at = ? WHERE id = ?`).run(...values, current.id);
            return current.id;
        }
        const result = db.prepare(`INSERT INTO groups (chat_id, owner_contact_id, subject, subject_owner_contact_id, description, description_id, size, created_at_ms, subject_updated_at_ms, description_updated_at_ms, addressing_mode, ephemeral_duration, ephemeral_trigger, restrict_enabled, announce_enabled, is_parent_group, is_closed_community, default_subgroup, general_subgroup, hidden_subgroup, allow_non_admin_subgroup_creation, limit_sharing_enabled, membership_approval_enabled, member_add_mode, member_link_mode, member_share_group_history_mode, participant_label_enabled, evolution_version, growth_locked_expiration, appeal_status, appeal_update_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chatId, ...values);
        const groupId = Number(result.lastInsertRowid);
        for (const member of group.participants ?? []) {
            const memberJid = member.jid ?? member.id ?? member.participant;
            if (!memberJid) continue;
            const contactId = ensureContact({ identifiers: [memberJid, member.lid].filter(Boolean), displayName: member.displayName, username: member.username });
            db.prepare(`INSERT INTO group_members (group_id, contact_id, jid, lid_jid, phone_jid, display_name, username, role, is_admin, is_super_admin, expiration_seconds, active, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, jid) DO UPDATE SET contact_id = excluded.contact_id, lid_jid = excluded.lid_jid, phone_jid = excluded.phone_jid, display_name = excluded.display_name, username = excluded.username, role = excluded.role, is_admin = excluded.is_admin, is_super_admin = excluded.is_super_admin, expiration_seconds = excluded.expiration_seconds, active = 1, updated_at = excluded.updated_at`).run(groupId, contactId, memberJid, member.lid ?? null, member.phoneNumber ? `${member.phoneNumber}@s.whatsapp.net` : null, member.displayName ?? null, member.username ?? null, member.role ?? null, member.admin ? 1 : 0, member.isSuperAdmin ? 1 : 0, member.expirationSeconds ?? null, 1, member.joinedAt ?? null, Date.now());
        }
        return groupId;
    }

    function persistGroupEvent(event) {
        const jid = event?.groupJid ?? event?.jid ?? event?.id ?? event?.group?.id;
        const groupId = jid ? db.prepare("SELECT id FROM groups g JOIN chats c ON c.id = g.chat_id WHERE c.jid = ? LIMIT 1").get(jid)?.id ?? null : null;
        const author = event?.author ?? event?.participant ?? event?.actor;
        const authorContactId = author ? ensureContact({ identifiers: [author] }) : null;
        const result = db.prepare(`INSERT INTO group_events (group_id, action, author_contact_id, group_jid, context_group_jid, timestamp_ms, subject, subject_owner_jid, description, description_id, code, expiration_seconds, mode, enabled, reason, request_method, details_json, raw_event_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(groupId, event?.action ?? event?.type ?? "unknown", authorContactId, jid ?? null, event?.contextGroupJid ?? null, timestampMs(event?.timestampMs ?? event?.timestampSeconds), event?.subject ?? null, event?.subjectOwner ?? null, event?.description ?? null, event?.descriptionId ?? null, event?.code ?? null, event?.expirationSeconds ?? null, event?.mode ?? null, event?.enabled === undefined ? null : bool(event.enabled), event?.reason ?? null, event?.requestMethod ?? null, json(event), json(event), Date.now());
        const eventId = Number(result.lastInsertRowid);
        for (const participant of event?.participants ?? []) {
            const participantJid = participant.jid ?? participant.id ?? participant.participant;
            const contactId = participantJid ? ensureContact({ identifiers: [participantJid, participant.lid].filter(Boolean), displayName: participant.displayName, username: participant.username }) : null;
            db.prepare(`INSERT INTO group_event_participants (group_event_id, contact_id, jid, lid_jid, phone_jid, display_name, username, role, expiration_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eventId, contactId, participantJid ?? null, participant.lid ?? null, participant.phoneJid ?? null, participant.displayName ?? null, participant.username ?? null, participant.role ?? null, participant.expirationSeconds ?? null);
        }
        return eventId;
    }

    function saveHistoryChunk(event) {
        db.prepare(`INSERT INTO history_sync_chunks (sync_type, messages_count, conversations_count, pushnames_count, inline_contacts_count, chunk_order, progress, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(event?.syncType ?? 0, event?.messagesCount ?? 0, event?.conversationsCount ?? 0, event?.pushnamesCount ?? 0, event?.inlineContactsCount ?? 0, event?.chunkOrder ?? null, event?.progress ?? null, Date.now());
    }

    function saveGroupHistoryBundle(event) {
        const jid = event?.groupJid;
        if (!jid) return;
        const chatId = ensureChat({ jid, type: "group" });
        const senderContactId = event?.senderJid ? ensureContact({ identifiers: [event.senderJid] }) : null;
        db.prepare(`INSERT INTO group_history_bundles (group_chat_id, group_jid, sender_contact_id, bundle_message_id, messages_count, out_of_window_pins_count, dropped_count, oldest_timestamp_ms, history_receivers_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chatId, jid, senderContactId, event?.messageId ?? null, event?.messagesCount ?? 0, event?.outOfWindowPinsCount ?? 0, event?.droppedCount ?? 0, timestampMs(event?.oldestTimestampMs ?? event?.oldestTimestamp), json(event?.historyReceivers ?? event?.historyReceiversJids ?? []), Date.now());
    }

    return {
        ensureContact,
        ensureChat,
        upsertStoredMessage,
        getStoredMessage,
        listStoredMessages,
        deleteStoredMessage: (id) => db.prepare("DELETE FROM messages WHERE message_id = ?").run(id).changes,
        clearStoredMessages: () => db.prepare("DELETE FROM messages").run(),
        upsertStoredThread,
        getStoredThread,
        listStoredThreads,
        deleteStoredThread: (jid) => db.prepare("DELETE FROM chats WHERE jid = ?").run(jid).changes,
        clearStoredThreads: () => db.prepare("DELETE FROM chats").run(),
        upsertStoredContact,
        getStoredContact,
        getStoredContactByPhoneNumber,
        deleteStoredContact: (jid) => { const row = db.prepare("SELECT contact_id FROM contact_identities WHERE value = ? LIMIT 1").get(jid); return row ? db.prepare("DELETE FROM contacts WHERE id = ?").run(row.contact_id).changes : 0; },
        clearStoredContacts: () => db.prepare("DELETE FROM contacts").run(),
        upsertMessage,
        saveReceipt,
        persistGroupEvent,
        upsertGroupMetadata,
        saveHistoryChunk,
        saveGroupHistoryBundle,
        saveGenericMessageEvent
    };
}
