import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataDir = path.resolve(__dirname, "..", "data");
const authPath = path.join(dataDir, "state.db");
const databasePath = path.join(dataDir, "database.db");

fs.mkdirSync(dataDir, { recursive: true });

export const filePath = {
    auth: authPath,
    database: databasePath
};

export const botPn = process.env.BOT_NUMBER;
export const sId = process.env.SESSION_ID;
export const pairCode = process.env.PAIRING_CODE;
