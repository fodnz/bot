import { WaClient } from "zapo-js";

import { logger } from "./app/logger.js";
import { store } from "./app/zapo-store.js";
import { botPn, sId, pairCode } from "./config.js";

const client = new WaClient(
    {
        store,
        sessionId: sId,
        recoverFromClientTooOld: true,
        history: { enabled: true, requireFullSync: true }
    },
    logger
);

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
