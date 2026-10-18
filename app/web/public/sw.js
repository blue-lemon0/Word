/** Service Worker —— 让「添加到主屏幕」后的 app 断网也能开。
 *
 *  为什么是运行时缓存而不是构建期预缓存清单：构建产物带 hash
 *  （assets/index-xxxx.js），构建期才知道名字。运行时缓存不需要预先知道，
 *  代价是首次访问要联网一次（这本来也是必须的：要下载 app）。
 *
 *  两条策略，按「这个资源变了要紧吗」分：
 *   · 导航请求（打开页面）→ network-first：能联网就拿新的 index.html，
 *     拿不到才用缓存里的。HTML 旧了会白屏/跑旧代码，所以优先联网。
 *   · 静态资源（js/css/图标/种子包）→ stale-while-revalidate：先用缓存秒开，
 *     后台顺手更新。资源带 hash，旧的缓存也不会污染新的。
 *
 *  学习数据在 IndexedDB 里，不经过这里 —— 备份文件也不该进缓存。
 *
 *  改这个文件要把 CACHE 版本 +1，否则老用户拿到的还是旧逻辑。
 */
const CACHE = 'wordbank-v1'

self.addEventListener('install', (ev) => {
  // 壳层先存一份：装完立刻断网打开，也有个东西可回退
  ev.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['./', './index.html']).catch(() => undefined)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

/** 该不该缓存这个请求：只缓存同源 GET，且跳过备份/导出这类用户数据 */
function cacheable(req) {
  if (req.method !== 'GET') return false
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return false
  if (/\.(vwbak|json)$/.test(url.pathname) && /flags_|backup/i.test(url.pathname)) return false
  return true
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request
  if (!cacheable(req)) return

  // 导航：network-first，断网回退到缓存的 index.html
  if (req.mode === 'navigate') {
    ev.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req)
          const c = await caches.open(CACHE)
          c.put('./index.html', fresh.clone())
          return fresh
        } catch {
          const c = await caches.open(CACHE)
          return (
            (await c.match('./index.html')) ||
            (await c.match('./')) ||
            new Response('离线且没有缓存', { status: 503 })
          )
        }
      })(),
    )
    return
  }

  // 其余：stale-while-revalidate
  ev.respondWith(
    (async () => {
      const c = await caches.open(CACHE)
      const hit = await c.match(req)
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) c.put(req, res.clone())
          return res
        })
        .catch(() => undefined)
      return hit || (await net) || new Response('', { status: 504 })
    })(),
  )
})