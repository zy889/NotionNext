import { NotionAPI as NotionLibrary } from 'notion-client'
import BLOG from '@/blog.config'
import path from 'path'
import { RateLimiter } from './RateLimiter'
import {
  getNotionBuildRateMaxPerMinute,
  getNotionBuildRateMinIntervalMs,
  logBuildEnvSummary
} from '@/lib/build/buildEnv'

// 限流配置，打包编译阶段避免接口频繁，限制频率
const useRateLimiter = process.env.BUILD_MODE || process.env.EXPORT
const lockFilePath = path.resolve(process.cwd(), '.notion-api-lock')
const rateLimiter = new RateLimiter(
  getNotionBuildRateMaxPerMinute(),
  lockFilePath,
  getNotionBuildRateMinIntervalMs()
)
if (useRateLimiter) {
  logBuildEnvSummary()
}

const globalStore = { notion: null, inflight: new Map() }

function getRawNotion() {
  if (!globalStore.notion) {
    globalStore.notion = new NotionLibrary({
      apiBaseUrl: BLOG.API_BASE_URL || 'https://www.notion.so/api/v3',
      activeUser: BLOG.NOTION_ACTIVE_USER || null,
      authToken: BLOG.NOTION_TOKEN_V2 || null,
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // notion-client v7 uses ofetch (not ky), so browser-like headers must be
      // passed via ofetchOptions. Without a real User-Agent/Origin, Notion's
      // Cloudflare layer returns 403 for server-side fetches and the site
      // silently renders empty (posts: []).
      ofetchOptions: {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Origin: 'https://www.notion.so'
        }
      }
    })
  }
  return globalStore.notion
}

async function callNotion(methodName, ...args) {
  const notion = getRawNotion()
  const original = notion[methodName]
  if (typeof original !== 'function') throw new Error(`${methodName} is not a function`)

  const key = `${methodName}-${JSON.stringify(args)}`

  if (globalStore.inflight.has(key)) return globalStore.inflight.get(key)

  // 注意：原函数已返回 Promise，不需要再 async 包一层
  const execute = () => original.apply(notion, args)
  const promise = useRateLimiter
    ? rateLimiter.enqueue(key, execute)
    : Promise.resolve().then(execute)

  globalStore.inflight.set(key, promise)
  // 始终把 inflight 清掉；即便上层不消费 reject 也不抛 unhandledRejection
  promise
    .catch(() => {})
    .finally(() => globalStore.inflight.delete(key))
  return promise
}

export const notionAPI = {
  getPage: (...args) => callNotion('getPage', ...args),
  getBlocks: (...args) => callNotion('getBlocks', ...args),
  getSignedFileUrls: (...args) => callNotion('getSignedFileUrls', ...args),
  getUsers: (...args) => callNotion('getUsers', ...args),
  __call: callNotion
}

export default notionAPI
