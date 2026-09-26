// Продакшен-сборка клиента для стенда. Без минификации: имена компонентов и функций видны в профиле и в подсчёте
// рендеров, а скорость работы та же. Каталоги приходят из stand.mjs через окружение.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const react = (await import(require.resolve('@vitejs/plugin-react'))).default

export default {
  root: process.env.STAND_CLIENT_ROOT,
  cacheDir: process.env.STAND_CACHE,
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: process.env.STAND_OUT, emptyOutDir: true, minify: false, sourcemap: false },
}
