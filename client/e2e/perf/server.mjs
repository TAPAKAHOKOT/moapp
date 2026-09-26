// Сервер стенда: настоящее Fastify-приложение из снимка кода, отдельная SQLite, клиентская сборка из того же снимка,
// без планировщиков и исходящих запросов, с синтетическими курсами по дням. Запускается из stand.mjs:
//   STAND_SRC=<каталог со server/src> STAND_DIST=<сборка клиента> DATABASE_PATH=<файл> PORT=<порт> node --import tsx server.mjs
const src = process.env.STAND_SRC
const port = Number(process.env.PORT ?? 4411)
if (!src || !process.env.DATABASE_PATH) throw new Error('нужны STAND_SRC и DATABASE_PATH')

process.env.SESSION_SECRET ??= 'moapp-perf-stand-session-secret-000000000000'
process.env.INTEGRATION_ENCRYPTION_KEY ??= 'moapp-perf-stand-integration-key-00000000000'
process.env.APP_ORIGIN ??= `http://localhost:${port}`
process.env.DEVICE_LINK_TTL_MINUTES ??= '10080'
process.env.DEVICE_LINK_RATE_LIMIT_PER_HOUR ??= '1000'

const { buildApp } = await import(`${src}/server/src/app.ts`)
const { configFromEnv } = await import(`${src}/server/src/config.ts`)
const app = await buildApp(configFromEnv(), { logger: false, scheduler: false, ...(process.env.STAND_DIST ? { staticRoot: process.env.STAND_DIST } : {}) })

// Курсы к евро за ~14 месяцев с плавным колебанием: пересчёт по курсу дня виден, а внешний сервис не нужен.
const insert = app.db.prepare(`INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at)
  VALUES (?,?,?,?,?) ON CONFLICT(rate_date,base_currency,quote_currency) DO NOTHING`)
app.db.transaction(() => {
  const now = new Date()
  for (let back = 0; back <= 430; back++) {
    const date = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10)
    const wave = Math.sin(back / 17)
    insert.run(date, 'EUR', 'EUR', 1, now.toISOString())
    insert.run(date, 'EUR', 'RSD', 117.1 + wave * 0.3, now.toISOString())
    insert.run(date, 'EUR', 'USD', 1.08 + wave * 0.02, now.toISOString())
    insert.run(date, 'EUR', 'RUB', 96 + wave * 3, now.toISOString())
    insert.run(date, 'EUR', 'GBP', 0.85 + wave * 0.01, now.toISOString())
  }
})()

await app.listen({ host: '127.0.0.1', port })
console.log(`stand server on http://localhost:${port}`)
