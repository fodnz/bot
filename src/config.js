import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const dataDir = path.resolve(__dirname, '..', 'data')
const authPath = path.join(dataDir, 'state.db')

fs.mkdirSync(dataDir, { recursive: true })

export const filePath = {
  auth: authPath,
}

export const botNumber = process.env.BOT_NUMBER ?? null