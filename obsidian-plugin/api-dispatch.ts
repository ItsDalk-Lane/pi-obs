// 接入层：UI 与引擎之间唯一的两个接触面 —— `fetch` 与 `EventSource`。
//
// 现有界面（约 39k 行）里有 121 处 `fetch("/api/...")` 与若干 `new EventSource(...)`。
// 接管这两个全局对象，界面代码一行都不用改，剩下的就是把路由调度到进程内的服务层。
//
// 两条硬约束：
//   1. 只处理 `/api/` 前缀，其余请求原样交给浏览器（再转 platform-fetch 的 shim），
//      不碰 Obsidian 自身与其它插件。
//   2. 任何处理器抛出的异常都在这里转成标准错误响应，绝不让它冒泡到 Obsidian 的事件循环。

import { jsonError, notMigrated } from "./services/respond";
import { agentEvents } from "./services/agent";
import { matchApiRoute } from "./services/routes";

/**
 * 进程内 Request 用的合成源。
 *
 * 为什么不用页面的 `app://obsidian.md`：`new Request()` 对自定义协议可能直接抛
 * "Invalid URL"。处理器只关心 pathname / searchParams / headers / signal，
 * 所以这里给一个普通的 http 源，行为与浏览器里完全一致。
 */
const INTERNAL_ORIGIN = "http://pi-obs.internal";

const API_PREFIX = "/api/";

/** `/api/agent/<id>/events`，阶段 1 唯一支持的 SSE 端点。 */
const AGENT_EVENTS_PATH = /^\/api\/agent\/([^/]+)\/events$/;

export interface ApiLayerOptions {
  log?: Pick<Console, "warn" | "error">;
}

function absoluteHref(input: RequestInfo | URL): string | null {
  if (typeof input === "string") {
    try { return new URL(input, window.location.href).href; } catch { return null; }
  }
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  const url = (input as Request | null)?.url;
  return typeof url === "string" ? url : null;
}

function methodHasNoBody(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** 把浏览器形态的调用折成一个绝对地址的 Request，处理器只看到标准对象。 */
async function buildRequest(
  internalUrl: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Request> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const method = (init?.method ?? input.method).toUpperCase();
    const carried = init?.body ?? (input.body ? await input.arrayBuffer() : undefined);
    return new Request(internalUrl, {
      method,
      headers,
      body: methodHasNoBody(method) || carried === undefined ? undefined : carried,
      signal: init?.signal ?? input.signal,
      redirect: init?.redirect,
      cache: init?.cache,
      credentials: init?.credentials,
      integrity: init?.integrity,
      keepalive: init?.keepalive,
      mode: init?.mode,
      referrer: init?.referrer,
      referrerPolicy: init?.referrerPolicy,
    });
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body;
  return new Request(internalUrl, {
    method,
    headers: init?.headers,
    body: methodHasNoBody(method) || body === undefined || body === null ? undefined : body,
    signal: init?.signal ?? undefined,
    redirect: init?.redirect,
    cache: init?.cache,
    credentials: init?.credentials,
    integrity: init?.integrity,
    keepalive: init?.keepalive,
    mode: init?.mode,
    referrer: init?.referrer,
    referrerPolicy: init?.referrerPolicy,
  });
}

/** EventSource 的最小替身：够 `lib/agent-event-connection.ts` 用。 */
class PiObsEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly withCredentials = false;
  readonly url: string;

  private readonly abort = new AbortController();
  private closed = false;
  private readonly log: Pick<Console, "warn" | "error">;

  constructor(url: string | URL, log: Pick<Console, "warn" | "error">) {
    super();
    this.log = log;
    let href: string;
    try {
      href = typeof url === "string" ? new URL(url, window.location.href).href : url.href;
    } catch {
      href = String(url);
    }
    this.url = href;
    void this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = PiObsEventSource.CLOSED;
    this.abort.abort();
  }

  private async connect(): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(this.url).pathname;
    } catch {
      this.fail(new Error(`Malformed EventSource URL: ${this.url}`));
      return;
    }

    const match = AGENT_EVENTS_PATH.exec(pathname);
    if (!match) {
      // 阶段 2 补齐：文件监听、终端事件、OAuth 登录流仍是 HTTP 形态。
      this.fail(new Error(`EventSource endpoint not available in the Obsidian plugin yet: ${pathname}`));
      return;
    }

    const sessionId = decodeURIComponent(match[1]);
    let response: Response;
    try {
      const internalUrl = `${INTERNAL_ORIGIN}${pathname}`;
      const request = new Request(internalUrl, {
        headers: { Accept: "text/event-stream" },
        signal: this.abort.signal,
      });
      response = await agentEvents(request, { params: { id: sessionId }, url: new URL(internalUrl) });
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.closed) return;
    if (response.status === 204) {
      this.close();
      return;
    }
    if (!response.ok || !response.body) {
      this.fail(new Error(`Agent event stream failed: HTTP ${response.status}`));
      return;
    }

    try {
      await this.pump(response.body);
    } catch (error) {
      if (!this.closed) this.fail(error);
      return;
    }
    // 服务端正常收流（会话结束/关机）：浏览器 EventSource 会自行重连，这里同样报错让上层决定。
    if (!this.closed) this.fail(new Error("Agent event stream closed by the server"));
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.handleFrame(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  /** 拆 SSE 帧：只认 `data:`，心跳帧（以 `:` 开头的注释）直接丢弃。 */
  private handleFrame(frame: string): void {
    const chunks: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      chunks.push(line.slice(5).replace(/^ /, ""));
    }
    if (chunks.length === 0) return;

    if (this.readyState !== PiObsEventSource.OPEN) {
      this.readyState = PiObsEventSource.OPEN;
      const opened = new Event("open");
      this.onopen?.(opened);
      this.dispatchEvent(opened);
    }
    const message = new MessageEvent<string>("message", { data: chunks.join("\n") });
    this.onmessage?.(message);
    this.dispatchEvent(message);
  }

  private fail(error: unknown): void {
    if (!this.closed) {
      this.closed = true;
      this.readyState = PiObsEventSource.CLOSED;
      this.abort.abort();
    }
    this.log.warn("[pi-obs] event stream:", error instanceof Error ? error.message : error);
    const event = new Event("error");
    this.onerror?.(event);
    this.dispatchEvent(event);
  }
}

/**
 * 装上接入层，返回卸载函数。
 *
 * 调用顺序有要求：必须在 `installPlatformFetch()` 之后，
 * 这样非 `/api/` 的请求才会落到 node fetch shim 上。
 */
export function installApiLayer(options: ApiLayerOptions = {}): () => void {
  const log = options.log ?? console;
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const reportedPaths = new Set<string>();

  const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = absoluteHref(input);
    if (!href) return originalFetch(input, init);

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return originalFetch(input, init);
    }
    if (!parsed.pathname.startsWith(API_PREFIX)) {
      return originalFetch(input, init);
    }

    let request: Request;
    try {
      request = await buildRequest(`${INTERNAL_ORIGIN}${parsed.pathname}${parsed.search}`, input, init);
    } catch (error) {
      // 构造 Request 就失败（比如信号已中止）：按同源 fetch 的语义抛出去。
      throw error;
    }

    const method = request.method.toUpperCase();
    const requestUrl = new URL(request.url);
    const match = matchApiRoute(method, requestUrl.pathname);
    if (!match) {
      const key = `${method} ${requestUrl.pathname}`;
      if (!reportedPaths.has(key)) {
        reportedPaths.add(key);
        log.warn(`[pi-obs] route not migrated yet: ${key}`);
      }
      return notMigrated(method, requestUrl.pathname);
    }

    try {
      return await match.route.handler(request, { params: match.params, url: requestUrl });
    } catch (error) {
      // 错误围栏：引擎异常在这里终结，不能让它冒泡到 Obsidian 的事件循环。
      log.error(`[pi-obs] ${method} ${requestUrl.pathname} failed`, error);
      return jsonError(error);
    }
  };

  globalThis.fetch = apiFetch as typeof globalThis.fetch;
  const EventSourceShim = class extends PiObsEventSource {
    constructor(url: string | URL) {
      super(url, log);
    }
  };
  globalThis.EventSource = EventSourceShim as unknown as typeof EventSource;

  return () => {
    if (globalThis.fetch === (apiFetch as typeof globalThis.fetch)) globalThis.fetch = originalFetch;
    if (globalThis.EventSource === (EventSourceShim as unknown as typeof EventSource)) {
      globalThis.EventSource = originalEventSource;
    }
  };
}
