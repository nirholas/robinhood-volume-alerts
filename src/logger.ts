import { pino } from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || 'info',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
})
