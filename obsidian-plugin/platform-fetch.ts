// 平台适配层 · 网络：Obsidian 渲染进程专用的 fetch 实现。
//
// 为什么需要它（Phase 0 实测）：
//   - 渲染进程里 globalThis.fetch 是 Chromium 的实现，受 CORS / 混合内容 / 系统代理限制，
//     连本机 127.0.0.1 的 LLM 服务都会 "Failed to fetch"
//   - undici 也不可用：它的定时器调用了 timer.unref()，而渲染进程里 setTimeout 是 DOM 版的，没有 unref
//
// 思路：不发请求走 Chromium 网络栈（那是 CORS 的来源），而是用 node:http/https 发，
// 再借用浏览器环境现成的 Response / Headers / ReadableStream 把结果包装成标准 Response，
// 这样 OpenAI SDK（pi-ai 的 HTTP 层）拿到的是完全标准的响应对象。

import { request as httpRequest, RequestOptions, IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import { createGunzip, createInflate, createBrotliDecompress } from "zlib";

type HeadersInitLike = Headers | Record<string, string> | Array<[string, string]>;

interface FetchInitLike {
  method?: string;
  headers?: HeadersInitLike;
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
  redirect?: string;
}

const MAX_REDIRECTS = 5;

function toRecord(headers: HeadersInitLike | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value: string, key: string) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k] = String(v);
  }
  return out;
}

function decompressStream(res: IncomingMessage): NodeJS.ReadableStream {
  const encoding = (res.headers["content-encoding"] ?? "").toString().toLowerCase();
  if (encoding.includes("br")) return res.pipe(createBrotliDecompress());
  if (encoding.includes("gzip")) return res.pipe(createGunzip());
  if (encoding.includes("deflate")) return res.pipe(createInflate());
  return res;
}

function buildResponse(res: IncomingMessage, status: number, statusText: string): Response {
  const source = decompressStream(res);
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        // 背压：队列满了就暂停读 socket，等下游 pull 时再恢复
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on("end", () => { try { controller.close(); } catch { /* 已关闭 */ } });
      source.on("error", (error: Error) => { try { controller.error(error); } catch { /* 已关闭 */ } });
    },
    // 关键：恢复必须由 pull 驱动，否则 pause 之后永远没人 resume（会静默死锁）
    pull() { source.resume(); },
    cancel() {
      source.on("error", () => { /* 忽略取消后的错误 */ });
      (source as { destroy?: () => void }).destroy?.();
      controllerRef = null;
    },
  });

  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase() === "content-encoding") continue; // 已解压
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, String(value));
  }

  return new Response(stream, { status, statusText, headers });
}

function once(input: string, init: FetchInitLike | undefined, redirectsLeft: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let url: URL;
    try { url = new URL(input); } catch { reject(new TypeError(`Invalid URL: ${input}`)); return; }

    const method = (init?.method ?? "GET").toUpperCase();
    const headers = toRecord(init?.headers);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept-encoding")) {
      headers["accept-encoding"] = "gzip, deflate, br";
    }

    const options: RequestOptions & { headers?: Record<string, string> } = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    };

    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(options, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const statusText = res.statusMessage ?? "";
      const location = res.headers.location;

      const isRedirect = status >= 300 && status < 400 && typeof location === "string";
      if (isRedirect && (init?.redirect ?? "follow") !== "manual") {
        res.resume();
        if (redirectsLeft <= 0) { reject(new TypeError("Too many redirects")); return; }
        const next = new URL(location, url).toString();
        once(next, { ...init, method: status === 303 ? "GET" : method }, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      resolve(buildResponse(res, status, statusText));
    });

    req.on("error", reject);

    if (init?.signal) {
      const signal = init.signal;
      if (signal.aborted) {
        req.destroy(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    }

    const body = init?.body;
    if (body != null) req.write(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body));
    req.end();
  });
}

/** 返回可直接赋值到 globalThis.fetch 的实现 */
export function createNodeFetch(): typeof globalThis.fetch {
  const impl = (input: string | URL | Request, init?: FetchInitLike): Promise<Response> => {
    if (typeof input === "object" && input !== null && "url" in (input as Request)) {
      const reqLike = input as Request;
      const merged: FetchInitLike = {
        method: init?.method ?? reqLike.method,
        headers: init?.headers ?? (() => { const h: Record<string, string> = {}; reqLike.headers.forEach((v, k) => { h[k] = v; }); return h; })(),
        signal: init?.signal ?? reqLike.signal,
        body: init?.body ?? undefined,
        redirect: init?.redirect,
      };
      return once(reqLike.url, merged, MAX_REDIRECTS);
    }
    return once(String(input), init, MAX_REDIRECTS);
  };
  return impl as unknown as typeof globalThis.fetch;
}

/** 请求目标的绝对 URL 字符串，用于判断该不该走 node:http。 */
function requestHref(input: string | URL | Request): string | null {
  if (typeof input === "string") {
    try { return new URL(input, window.location.href).href; } catch { return null; }
  }
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  const url = (input as Request | null)?.url;
  return typeof url === "string" ? url : null;
}

/**
 * 接管 globalThis.fetch：http/https 走 node:http，其余协议（app://、blob:、data: 等）
 * 原样交给 Chromium 的实现。
 *
 * 为什么要分流而不是整体替换：Obsidian 自身与其它插件也可能用 fetch 取 app:// 资源，
 * 那些请求 node:http 处理不了。分流把影响面限制在真正的网络请求上。
 *
 * 返回一个恢复原状的函数，插件卸载时调用。
 */
export function installPlatformFetch(): () => void {
  const original = globalThis.fetch;
  const nodeFetch = createNodeFetch();
  const hybrid = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = requestHref(input);
    if (href && /^https?:/i.test(href)) {
      return nodeFetch(input as never, init as never);
    }
    return original.call(globalThis, input as never, init as never);
  }) as typeof globalThis.fetch;
  globalThis.fetch = hybrid;
  return () => {
    if (globalThis.fetch === hybrid) globalThis.fetch = original;
  };
}
