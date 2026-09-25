/**
 * 静态资源托管 —— 前端构建产物（`web-local/dist` / `web-portal/dist`）。
 *
 * ## 🚨 只用 `node:fs/promises`，不用 `Bun.file()`
 *
 * npm 发布出去的那份 CLI 要跑在 **Node** 上（`--web` 内嵌本服务），
 * 所以静态读取不能碰 Bun 专有 API。`node:fs/promises` 两个运行时都有。
 *
 * ## ⚠️ 这一层**不决定** `/api/*` 的命运
 *
 * 它只回答「dist 里有没有这个文件」。未命中时返回 `null`，
 * 由调用方（`app.ts` 的兜底处理器）决定是回落 `index.html` 还是回 JSON 404 ——
 * 而 `/api/*` 一律**不回退**（理由见 `app.ts` 里那段注释）。
 *
 * ## ★ S12.3 的四件事都在这一个文件里
 *
 * 1. **`ETag` + `304`**：ETag 由「大小 + 修改时间」派生（弱 ETag，不用读内容），
 *    具体的 `If-None-Match` 比对与 304 组装交给 `hono/etag`（见 `app.ts`）；
 * 2. **`Cache-Control`**：带 hash 的 Vite 产物 `immutable`，其余（含 `index.html`）
 *    `no-cache`；
 * 3. **`HEAD`**：与 GET **共用同一处构造**，头逐字相同、只是不带 body；
 * 4. **压缩**：只给文本类资源开（`hono/compress` 按 `Content-Type` 自行筛选），
 *    但「哪些响应能被压缩」由这里的 `Content-Type` / `Content-Length` 决定 ——
 *    所以 `Content-Length` 必须显式给出（见 `staticResponse()` 的注释）。
 *
 * ## 🚨 路径容器校验（原先是一句 `rel.includes('..')`）
 *
 * 两道，缺一不可：
 * 1. `resolve()` 之后的**字符串**校验 —— 挡住明文与百分号编码的 `..`
 *    （`%2e%2e` 解码后就是 `..`），以及 Windows 上 `\` 形式的变体；
 * 2. `realpath()` 之后的校验 —— ① 只做字符串归一，**不看 inode**：
 *    dist 里放一个指向外面的软链就能绕过第一道。
 * ⚠️ 两道都做完才 `readFile`：先读再校验等于把外面的文件读进了内存。
 */

import type { Stats } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** 静态产物里 `index.html` 的固定名字（SPA 回落用）。 */
const INDEX_HTML = 'index.html'

/**
 * 带内容 hash 的 Vite 产物可以永久缓存：内容一变文件名就变。
 *
 * ⚠️ 不要扩大成「`assets/` 下全部」—— `index.html` 与 `favicon.svg` 就躺在
 *   同一层，把它们标成 `immutable` 等于「用户永远拿不到新版，
 *   而且刷新也救不回来」（这正是本项目要在静态层做 ETag 的原因）。
 */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * 其余静态资源（含 `index.html`）的保守值：**每次都要回源协商**。
 *
 * ⚠️ 这里必须是 `no-cache` 而不是 `no-store`：前者允许缓存，但每次使用前都要带
 *   `If-None-Match` 回源确认 —— 确认下来是 304，省掉整个响应体。
 *   `no-store` 会让每次刷新都重新下载一遍 `index.html`，本文件的 ETag 就白算了。
 * 🚨 也**不要**写 `no-transform`：`hono/compress` 一见它就整段跳过压缩
 *   （见其源码里的 `shouldTransform`），表现为「压缩对 index.html 静默失效」。
 */
const CACHE_REVALIDATE = 'no-cache'

/**
 * 字符串容器校验：`target` 必须仍在 `root` 之内。
 *
 * ★ 比字符串前缀而不是「`rel` 里有没有 `..`」：前者是**结果**判定，
 *   后者是**特征**判定 —— 只要还有一种没被想到的编码/写法，
 *   特征判定就会放行，而结果判定不会。
 */
function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/**
 * 用「大小 + 修改时间」派生弱 ETag。
 *
 * ★ 刻意用**弱** ETag（`W/`）：
 * 1. 同一个 URL 在 `Accept-Encoding: gzip` 下的字节与明文并不相同，强 ETag
 *    按定义就不能跨编码复用；`hono/compress` 也会把强 ETag 自动降级成弱 ETag，
 *    从这里就写弱可以避免「200 那次发强 ETag、304 那次发弱 ETag」的不一致；
 * 2. 它不需要把文件读一遍再算 SHA-1 —— 静态资源的 ETag 只要在「文件变了」时
 *    变化即可，`size + mtimeMs` 足够（nginx 的默认做法也是这一组）。
 */
function etagOf(info: { size: number; mtimeMs: number }): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
}

/**
 * 是不是 Vite 的 hashed 产物。
 *
 * ⚠️ 判据必须同时满足「在 `assets/` 下」与「文件名末尾带 hash」两条：
 *   只看扩展名会把 `favicon.svg` 也算进去，只看目录会把手工放进去的
 *   `assets/logo.svg` 算进去 —— 两者都会变成「永远不更新且无法察觉」。
 */
function isImmutableAsset(rel: string): boolean {
  if (!rel.startsWith('assets/')) return false
  const name = rel.slice('assets/'.length)
  // 只在 `assets/` 这一层判定：嵌套目录一律按保守值处理
  if (name.includes('/')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  // Vite 的 hash 是 base64url 风格 8 位（实测形如 `index-4bSwXGj-.js`、
  // `BreakdownTable.vue_..._lang-BpbSfYIZ.js`），故字符集要含 `-` 与 `_`
  return /-[A-Za-z0-9_-]{8,}$/.test(name.slice(0, dot))
}

/** 某个相对路径该用哪条 `Cache-Control`。 */
export function cacheControlOf(rel: string): string {
  return isImmutableAsset(rel) ? CACHE_IMMUTABLE : CACHE_REVALIDATE
}

/** 读文件 + stat（ETag 需要 stat 里的 size/mtime，所以两者一次一起拿）。 */
async function statFileOrNull(path: string): Promise<{ data: Buffer; info: Stats } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return { data: await readFile(path), info }
  } catch {
    return null
  }
}

/**
 * 读取一个文件；不存在或不是普通文件时返回 null。
 *
 * ⚠️ 它**不做**容器校验（拿到什么路径就读什么路径）—— 只给已经自己校验过
 *   路径的调用方用。静态托管一律走 {@link serveStatic}。
 */
export async function readFileOrNull(path: string): Promise<Buffer | null> {
  return (await statFileOrNull(path))?.data ?? null
}

/**
 * 把相对路径解析成 dist 内的真实文件；越界 / 不存在 / 是目录都返回 `null`。
 *
 * 这是**唯一**会把 `rel` 变成磁盘路径的地方，两道容器校验都在这里。
 */
async function readStaticFile(dir: string, rel: string): Promise<{ data: Buffer; etag: string } | null> {
  const root = resolve(dir)
  const target = resolve(root, rel)

  // 第一道：纯字符串，不碰磁盘。`../x`、`%2e%2e/x`、`..%5cx` 都死在这里。
  if (!isInside(root, target)) return null

  try {
    // 第二道：符号链接。两边**一起** realpath，所以「dist 本身是软链」这种
    // 正常部署不会被误判；而 dist 里一个指向外面的软链会被这一道拦下。
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
    if (!isInside(realRoot, realTarget)) return null

    const info = await stat(realTarget)
    if (!info.isFile()) return null
    // 读的是 realpath 之后的路径：与 stat 判定的必须是同一个 inode，
    // 否则「检查的是 A、读的是 B」这种 TOCTOU 就有机可乘。
    return { data: await readFile(realTarget), etag: etagOf(info) }
  } catch {
    // ENOENT（文件不存在）/ 权限不足 —— 与「没有这个文件」同解，
    // 交给调用方回落 index.html 或回 404。
    return null
  }
}

/**
 * 组装静态响应。
 *
 * ★ `HEAD` 与 `GET` **共用这一处**：头逐字相同，差别只有 body 是否为 null。
 *   （RFC 9110 §9.3.2：HEAD 的响应头应当与 GET 相同，除了那些「只有生成内容时
 *   才知道」的头 —— `hono/compress` 正是因此不给 HEAD 加 `Content-Encoding`。）
 *
 * ⚠️ `Content-Length` 必须显式给：① HEAD 要能报出 GET 会返回多长；
 *   ② `hono/compress` 的阈值判定读的就是这个头，缺了它就会连几百字节的
 *   小文件也压一遍（压缩后比原文还大）。
 */
function staticResponse(rel: string, file: { data: Buffer; etag: string }, method: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': contentTypeOf(rel),
    'Cache-Control': cacheControlOf(rel),
    ETag: file.etag,
    'Content-Length': String(file.data.byteLength),
  }
  return new Response(method === 'HEAD' ? null : file.data, { headers })
}

/**
 * 尝试提供静态文件；未命中返回 `null`。
 *
 * 返回 400（而不是 null）表示**请求格式错误**，不是「文件不存在」——
 * 见下面 `decodeURIComponent` 的注释。
 */
export async function serveStatic(
  dir: string,
  pathname: string,
  method: string = 'GET',
): Promise<Response | null> {
  // decodeURIComponent 会对非法百分号编码（如 `/%zz`）抛 URIError。
  // 这是客户端请求格式错误，不是服务缺陷 —— 直接回 400，
  // 否则会被外层兜底转成 500，排障时误以为是服务出 bug。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: '请求路径包含非法的 URL 编码' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  // 去掉前导 / 再进容器校验。
  // ⚠️ 这里不再有 `rel.includes('..')`：那种「特征判定」只挡得住想到的写法，
  //   实际的拦截在 `readStaticFile()` 里按**结果**判定（含符号链接）。
  const rel = decoded.replace(/^\/+/, '')
  if (!rel) return null

  const file = await readStaticFile(dir, rel)
  if (!file) return null

  return staticResponse(rel, file, method)
}

/**
 * SPA 回落：未命中任何文件时给出的 `index.html`。
 *
 * 与 {@link serveStatic} 走**同一套**缓存头与 ETag，所以「回落」出来的首页
 * 同样能拿到 304 —— 否则看板每次刷新都在下载一份完整的 HTML。
 */
export async function serveIndexHtml(dir: string, method: string = 'GET'): Promise<Response | null> {
  const file = await readStaticFile(dir, INDEX_HTML)
  if (!file) return null
  return staticResponse(INDEX_HTML, file, method)
}

/** 极简 MIME 表 —— 只覆盖 dist 里真实会出现的扩展名。 */
export function contentTypeOf(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}