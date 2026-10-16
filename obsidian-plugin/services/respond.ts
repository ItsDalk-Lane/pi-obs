// 服务层公共部分：处理器形状 + JSON 响应。
//
// 与 Next 路由的差别只在包装层：这些处理器跑在 Obsidian 进程内，没有网络往返，
// 所以 gzip、Server-Timing、Cache-Control: no-store 之外的东西都不需要。
// 业务逻辑一律从 ../../lib/* 原样取用，不在此重复实现。

/** 路由匹配结果：路径里的 `:name` 段。 */
export interface ApiRouteContext {
  params: Record<string, string>;
  url: URL;
}

/** 与原 `app/api/**\/route.ts` 导出同形，只是不再依赖 Next。 */
export type ApiHandler = (
  request: Request,
  context: ApiRouteContext,
) => Promise<Response> | Response;

export interface ApiRoute {
  method: string;
  /** 以 `/` 分隔的路径段，`:name` 表示通配一段。 */
  segments: string[];
  handler: ApiHandler;
}

/** 进程内响应统一带 no-store：客户端按 HTTP 缓存规则判新鲜度，这里必须显式禁掉。 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function json(data: unknown, status = 200): Response {
  return jsonResponse(data, status);
}

export function jsonError(error: unknown, status = 500): Response {
  return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, status);
}

/** 纯文本错误（SSE 路由的 404 用得到）。 */
export function textError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 未迁移路由的兜底：说明现状，别让界面拿到一个无法解析的响应。 */
export function notMigrated(method: string, pathname: string): Response {
  return jsonResponse(
    { error: `Not available in the Obsidian plugin yet: ${method} ${pathname}` },
    501,
  );
}
