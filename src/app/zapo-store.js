import { createStore } from "zapo-js";
import { createSqliteStore } from "@zapo-js/store-sqlite";

import { filePath } from "../config.js";

export function createZapoStore(databaseBackend) {
    const sqlite = createSqliteStore({
        path: filePath.auth,
        driver: "auto",
        pragmas: {
            journal_mode: "WAL",
            synchronous: "NORMAL"
        },
        cacheTtlMs: {
            retryMs: 60_000,
            groupMetadataMs: 10 * 60_000,
            chatMetadataMs: 10 * 60_000,
            deviceListMs: 10 * 60_000,
            messageSecretMs: 10 * 60_000
        }
    });

    return createStore({
        backends: {
            sqlite,
            database: databaseBackend
        },
        providers: {
            auth: "sqlite",
            signal: "sqlite",
            preKey: "sqlite",
            session: "sqlite",
            identity: "sqlite",
            senderKey: "sqlite",
            appState: "sqlite",
            privacyToken: "sqlite",
            messages: "database",
            threads: "database",
            contacts: "database"
        },
        cacheProviders: {
            retry: "memory",
            groupMetadata: "memory",
            chatMetadata: "memory",
            deviceList: "memory",
            messageSecret: "memory"
        }
    });
}
