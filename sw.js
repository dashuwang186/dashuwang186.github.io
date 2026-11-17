/**
 * 食光 Service Worker（阶段 9：真正做离线缓存）
 *
 * 目标：断网时至少还能打开应用、看到已缓存的历史记录。
 *
 * 策略：
 * 1. 应用外壳（index.html / manifest / 图标）：安装时预缓存；
 *    导航请求走「网络优先，失败回退缓存」——保证线上更新能生效，断网也能进。
 * 2. 带哈希的静态资源（/assets/…、/icons/…）：缓存优先，命中即用，回源后写入缓存。
 * 3. 其它 GET（图片、签名链接等）：网络优先 + 缓存兜底。
 * 4. 带令牌的云函数调用（POST）不缓存，避免把带令牌的响应写进磁盘。
 */
// 第 139 轮：缓存名升到 v12（第 128 轮升到 v11（第 126 轮升到 v10（第 123 轮升到 v8，第 125 轮升到 v9）——发布新版本时旧缓存会被 activate 阶段清掉，
// 免得手机上继续用着老 js/css。
const SHELL_CACHE = 'shiguang-shell-v13'
const ASSET_CACHE = 'shiguang-assets-v13'
const RUNTIME_CACHE = 'shiguang-runtime-v13'
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

/**
 * 阶段 10：应用外壳预缓存要包含构建产物的 js/css（文件名带哈希，只能运行时发现）。
 * 做法：install 时抓一次 index.html，把里面引用的 /assets/* 一起预缓存。
 */
async function collectAssetUrls() {
  try {
    const res = await fetch('/index.html', { cache: 'no-cache' })
    if (!res.ok) return []
    const html = await res.text()
    const urls = new Set()
    const pattern = /(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g
    let match = pattern.exec(html)
    while (match) {
      urls.add(match[1])
      match = pattern.exec(html)
    }
    return [...urls]
  } catch {
    return []
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        await cache.addAll(SHELL_URLS)
        const assets = await collectAssetUrls()
        if (assets.length) {
          const assetCache = await caches.open(ASSET_CACHE)
          await assetCache.addAll(assets)
        }
      })
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function isAssetRequest(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  )
}

function isNavigation(request) {
  return request.mode === 'navigate'
}

/** 缓存优先：命中直接返回，未命中则回源并写入缓存。 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response && response.ok) cache.put(request, response.clone())
  return response
}

/** 网络优先：断网时回退到缓存（没有缓存就抛错，让页面自己处理）。 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    // GitHub Pages 的 HTML 默认缓存 10 分钟，这里强制绕开 HTTP 缓存，
    // 保证老板一刷新就能拿到刚发布的版本。
    const response = await fetch(request, { cache: 'reload' })
    if (response && response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  if (sameOrigin && isNavigation(request)) {
    event.respondWith(
      networkFirst(request, SHELL_CACHE).catch(async () => {
        const cache = await caches.open(SHELL_CACHE)
        const fallback = (await cache.match('/index.html')) ?? (await cache.match('/'))
        if (fallback) return fallback
        return new Response('离线，且没有可用的缓存页面', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }),
    )
    return
  }

  if (sameOrigin && isAssetRequest(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
    return
  }

  if (!sameOrigin) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE).catch(() => Response.error()))
  }
})
