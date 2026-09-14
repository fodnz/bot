import { WaClient } from "zapo-js";

import { logger } from "./app/logger.js";
import { createZapoStore } from "./app/zapo-store.js";
import { botPn, sId, pairCode, filePath } from "./config.js";
import { initializeDatabase } from "./database/index.js";
import { createRepository } from "./database/repository.js";
import { registerDatabaseEvents } from "./database/events.js";
import { createDatabaseBackend } from "./database/stores.js";

const database = initializeDatabase(filePath.database);
const repository = createRepository(database);
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

registerDatabaseEvents(client, repository);

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

process.once("SIGINT", () => database.close());
process.once("SIGTERM", () => database.close());
