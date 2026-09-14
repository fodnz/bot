function toBoolean(value) {
    return value === undefined || value === null ? null : value ? 1 : 0;
}

function timestampMs(value) {
    if (value === undefined || value === null) return null;
    return Number(value) > 1e12 ? Number(value) : Number(value) * 1000;
}

function ensureGroup(db, chatId) {
    const current = db.prepare("SELECT id FROM groups WHERE chat_id = ? LIMIT 1").get(chatId);
    if (current) return current.id;
    const result = db.prepare("INSERT INTO groups (chat_id, updated_at) VALUES (?, ?)").run(chatId, Date.now());
    return Number(result.lastInsertRowid);
}

export function upsertGroupMetadataFixed(db, repository, group) {
    const jid = group?.id ?? group?.jid ?? group?.groupJid;
    if (!jid) return null;

    const ownerContactId = group.owner ? repository.ensureContact({ identifiers: [group.owner] }) : null;
    const subjectOwnerContactId = group.subjectOwner ? repository.ensureContact({ identifiers: [group.subjectOwner] }) : null;
    const chatId = repository.ensureChat({ jid, type: "group", name: group.subject ?? null });
    const groupId = ensureGroup(db, chatId);
    const now = Date.now();

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
        restrict_enabled: toBoolean(group.restrict),
        announce_enabled: toBoolean(group.announce),
        is_parent_group: toBoolean(group.isParentGroup),
        is_closed_community: toBoolean(group.isClosedCommunity),
        default_subgroup: toBoolean(group.defaultSubgroup),
        general_subgroup: toBoolean(group.generalSubgroup),
        hidden_subgroup: toBoolean(group.hiddenSubgroup),
        allow_non_admin_subgroup_creation: toBoolean(group.allowNonAdminSubgroupCreation),
        limit_sharing_enabled: toBoolean(group.limitSharingEnabled),
        membership_approval_enabled: toBoolean(group.membershipApprovalMode),
        member_add_mode: group.memberAddMode ?? null,
        member_link_mode: group.memberLinkMode ?? null,
        member_share_group_history_mode: group.memberShareGroupHistoryMode ?? null,
        participant_label_enabled: toBoolean(group.participantLabelEnabled),
        evolution_version: group.evolutionVersion ?? null,
        growth_locked_expiration: group.growthLockedExpiration ?? null,
        appeal_status: group.appealStatus ?? null,
        appeal_update_time: timestampMs(group.appealUpdateTime),
        updated_at: now
    };

    if (db.prepare("SELECT id FROM groups WHERE id = ? LIMIT 1").get(groupId)) {
        const entries = Object.entries(values);
        const setClause = entries.map(([column]) => `${column} = COALESCE(?, ${column})`).join(", ");
        db.prepare(`UPDATE groups SET ${setClause} WHERE id = ?`).run(...entries.map(([, value]) => value), groupId);
    }

    db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);

    const insertMember = db.prepare(`
        INSERT INTO group_members (
            group_id, contact_id, jid, lid_jid, phone_jid, display_name, username,
            role, is_admin, is_super_admin, expiration_seconds, active, joined_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const member of group.participants ?? []) {
        const memberJid = member.jid ?? member.id ?? member.participant;
        if (!memberJid) continue;
        const contactId = repository.ensureContact({
            identifiers: [memberJid, member.lid].filter(Boolean),
            displayName: member.displayName,
            username: member.username
        });
        insertMember.run(
            groupId,
            contactId,
            memberJid,
            member.lid ?? null,
            member.phoneNumber ? `${member.phoneNumber}@s.whatsapp.net` : null,
            member.displayName ?? null,
            member.username ?? null,
            member.role ?? null,
            member.admin ? 1 : 0,
            member.isSuperAdmin ? 1 : 0,
            member.expirationSeconds ?? null,
            1,
            member.joinedAt ?? null,
            now
        );
    }

    return groupId;
}
