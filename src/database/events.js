export function registerDatabaseEvents(client, repository) {
    let active = true;

    const onMessage = (event) => {
        if (!active) return;
        try { repository.upsertMessage(event, "inbound"); } catch (error) { console.error("database message persistence failed:", error); }
    };

    const onMessageSend = (event) => {
        if (!active) return;
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
    };

    const onReceipt = (event) => {
        if (!active) return;
        try { repository.saveReceipt(event); } catch (error) { console.error("database receipt persistence failed:", error); }
    };

    const eventNames = ["message_addon", "message_protocol", "message_unavailable", "message_bot_chunk", "newsletter_message_update"];
    const genericHandlers = new Map();

    for (const eventName of eventNames) {
        const handler = (event) => {
            if (!active) return;
            try { repository.saveGenericMessageEvent(eventName, event); } catch (error) { console.error(`database ${eventName} persistence failed:`, error); }
        };
        genericHandlers.set(eventName, handler);
        client.on(eventName, handler);
    }

    const onGroup = (event) => {
        if (!active) return;
        try { repository.persistGroupEvent(event); } catch (error) { console.error("database group persistence failed:", error); }
    };

    const onHistorySyncChunk = (event) => {
        if (!active) return;
        try { repository.saveHistoryChunk(event); } catch (error) { console.error("database history sync persistence failed:", error); }
    };

    const onGroupHistoryBundle = (event) => {
        if (!active) return;
        try { repository.saveGroupHistoryBundle(event); } catch (error) { console.error("database group history persistence failed:", error); }
    };

    const onConnection = (event) => {
        if (!active || event.status !== "open") return;
        void client.group.queryAllGroups().then((groups) => {
            if (!active) return;
            for (const group of groups) repository.upsertGroupMetadata(group);
        }).catch((error) => {
            if (!active) return;
            console.error("database group metadata synchronization failed:", error);
        });
    };

    client.on("message", onMessage);
    client.on("message_send", onMessageSend);
    client.on("receipt", onReceipt);
    client.on("group", onGroup);
    client.on("history_sync_chunk", onHistorySyncChunk);
    client.on("group_history_bundle", onGroupHistoryBundle);
    client.on("connection", onConnection);

    return function disable() {
        active = false;
        client.off("message", onMessage);
        client.off("message_send", onMessageSend);
        client.off("receipt", onReceipt);
        client.off("group", onGroup);
        client.off("history_sync_chunk", onHistorySyncChunk);
        client.off("group_history_bundle", onGroupHistoryBundle);
        client.off("connection", onConnection);
        for (const [eventName, handler] of genericHandlers) client.off(eventName, handler);
    };
}
