export function registerDatabaseEvents(client, repository) {
    client.on("message", (event) => {
        try { repository.upsertMessage(event, "inbound"); } catch (error) { console.error("database message persistence failed:", error); }
    });

    client.on("message_send", (event) => {
        try {
            repository.upsertMessage({
                to: event.to,
                id: event.id,
                key: {
                    remoteJid: event.to,
                    id: event.id,
                    fromMe: true,
                    isGroup: event.to?.endsWith("@g.us") ?? false,
                    isBroadcast: event.to?.endsWith("@broadcast") ?? false,
                    isNewsletter: event.to?.endsWith("@newsletter") ?? false
                },
                message: event.message
            }, "outbound");
        } catch (error) { console.error("database outbound message persistence failed:", error); }
    });

    client.on("receipt", (event) => {
        try { repository.saveReceipt(event); } catch (error) { console.error("database receipt persistence failed:", error); }
    });

    for (const eventName of ["message_addon", "message_protocol", "message_unavailable", "message_bot_chunk", "newsletter_message_update"]) {
        client.on(eventName, (event) => {
            try { repository.saveGenericMessageEvent(eventName, event); } catch (error) { console.error(`database ${eventName} persistence failed:`, error); }
        });
    }

    client.on("group", (event) => {
        try { repository.persistGroupEvent(event); } catch (error) { console.error("database group persistence failed:", error); }
    });

    client.on("history_sync_chunk", (event) => {
        try { repository.saveHistoryChunk(event); } catch (error) { console.error("database history sync persistence failed:", error); }
    });

    client.on("group_history_bundle", (event) => {
        try { repository.saveGroupHistoryBundle(event); } catch (error) { console.error("database group history persistence failed:", error); }
    });

    client.on("connection", (event) => {
        if (event.status !== "open") return;
        void client.group.queryAllGroups().then((groups) => {
            for (const group of groups) repository.upsertGroupMetadata(group);
        }).catch((error) => {
            console.error("database group metadata synchronization failed:", error);
        });
    });
}
