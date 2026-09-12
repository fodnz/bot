import fs from 'fs';
import pathModule from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

const dataDir = pathModule.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const authPath = pathModule.join(dataDir, 'state.db');

const authDirectory = pathModule.dirname(authPath);
if (!fs.existsSync(authDirectory)) {
  fs.mkdirSync(authDirectory, { recursive: true });
}

export const filePath = {
  auth: authPath
};
