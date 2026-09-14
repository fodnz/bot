export function createDatabaseBackend(repository) {
    return {
        stores: {
            messages: () => ({
                async upsert(record) { repository.upsertStoredMessage(record); },
                async upsertBatch(records) { for (const record of records) repository.upsertStoredMessage(record); },
                async getById(id) { return repository.getStoredMessage(id); },
                async listByThread(threadJid, limit, beforeTimestampMs) { return repository.listStoredMessages(threadJid, limit, beforeTimestampMs); },
                async deleteById(id) { return repository.deleteStoredMessage(id); },
                async clear() { repository.clearStoredMessages(); }
            }),
            threads: () => ({
                async upsert(record) { repository.upsertStoredThread(record); },
                async upsertBatch(records) { for (const record of records) repository.upsertStoredThread(record); },
                async getByJid(jid) { return repository.getStoredThread(jid); },
                async list(limit) { return repository.listStoredThreads(limit); },
                async deleteByJid(jid) { return repository.deleteStoredThread(jid); },
                async clear() { repository.clearStoredThreads(); }
            }),
            contacts: () => ({
                async upsert(record) { repository.upsertStoredContact(record); },
                async upsertBatch(records) { for (const record of records) repository.upsertStoredContact(record); },
                async getByJid(jid) { return repository.getStoredContact(jid); },
                async getByPhoneNumber(phoneNumber) { return repository.getStoredContactByPhoneNumber(phoneNumber); },
                async deleteByJid(jid) { return repository.deleteStoredContact(jid); },
                async clear() { repository.clearStoredContacts(); }
            })
        },
        caches: {}
    };
}
