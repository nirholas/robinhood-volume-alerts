import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load `.env` from the working directory into `process.env` using Node's
 * built-in parser (Node 20.12+). Variables already present in the
 * environment win, matching dotenv semantics, because `loadEnvFile` does
 * not overwrite existing keys. Missing file is fine: production deploys
 * usually inject real environment variables instead.
 */
export function loadDotEnv(path = '.env'): void {
  const file = resolve(process.cwd(), path)
  if (!existsSync(file)) return
  process.loadEnvFile(file)
}
