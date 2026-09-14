import { WaClient } from "zapo-js";

import { logger } from "./app/logger.js";
import { createZapoStore } from "./app/zapo-store.js";
import { botPn, sId, pairCode, filePath } from "./config.js";
import { initializeDatabase } from "./database/index.js";
import { createRepository } from "./database/repository-safe.js";
import { registerDatabaseEvents } from "./database/events.js";
import { createDatabaseBackend } from "./database/stores.js";
import { upsertGroupMetadataFixed } from "./database/group-metadata.js";

const database = initializeDatabase(filePath.database);
const repository = createRepository(database);
repository.upsertGroupMetadata = (group) => upsertGroupMetadataFixed(database, repository, group);
const databaseBackend = createDatabaseBackend(repository);
const store = createZapoStore(databaseBackend);

const client = new WaClient(
    {
        store,
        sessionId: sId,
        recoverFromClientTooOld: true,
        history: { enabled: true, requireFullSync: true }
    },
    logger
);

const disableDatabaseEvents = registerDatabaseEvents(client, repository);

client.on("auth_qr", async () => {
    await client.auth.requestPairingCode(botPn, true, pairCode);
});

client.on("auth_pairing_code", ({ code }) => {
    console.log(
        "Enter this code in WhatsApp:",
        code.match(/.{1,4}/g)?.join("-") ?? code
    );
});

client.on("auth_paired", ({ credentials }) => {
    console.log("Paired:", credentials.meJid);
});

client.on("connection", ({ status, reason }) => {
    console.log("connection:", status, reason);
});

await client.connect();

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    disableDatabaseEvents();

    try {
        await client.disconnect();
    } catch (error) {
        console.error(`client shutdown failed after ${signal}:`, error);
    } finally {
        if (database.opened) database.close();
    }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
