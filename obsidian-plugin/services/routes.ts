import type { ApiRoute } from "./respond";
import { deleteSession, getSession, getSessionState, listSessions, renameSession } from "./sessions";
import { agentEvents, getAgentState, postAgentCommand, postAgentNew } from "./agent";
import { getHome, getModels, getRunningSessions } from "./platform";

/**
 * 调度表。路径段与 Method 都和原 `app/api/**` 一致，
 * 阶段 2 按分组往这里继续加，不改接入层。
 *
 * 静态段全部列在前面只是为了可读性：匹配器会先跑一遍全静态匹配，
 * 所以 `/api/agent/new` 与 `/api/agent/:id` 不会撞。
 */
export const API_ROUTES: ApiRoute[] = [
  { method: "GET", segments: ["api", "sessions"], handler: listSessions },
  { method: "GET", segments: ["api", "sessions", ":id"], handler: getSession },
  { method: "GET", segments: ["api", "sessions", ":id", "state"], handler: getSessionState },
  { method: "PATCH", segments: ["api", "sessions", ":id"], handler: renameSession },
  { method: "DELETE", segments: ["api", "sessions", ":id"], handler: deleteSession },

  { method: "POST", segments: ["api", "agent", "new"], handler: postAgentNew },
  { method: "GET", segments: ["api", "agent", "running"], handler: getRunningSessions },
  { method: "POST", segments: ["api", "agent", ":id"], handler: postAgentCommand },
  { method: "GET", segments: ["api", "agent", ":id"], handler: getAgentState },
  { method: "GET", segments: ["api", "agent", ":id", "events"], handler: agentEvents },

  { method: "GET", segments: ["api", "home"], handler: getHome },
  { method: "GET", segments: ["api", "models"], handler: getModels },
];

export interface ApiRouteMatch {
  route: ApiRoute;
  params: Record<string, string>;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 按 pathname 找处理器。先跑一遍全静态匹配，再跑带通配的；
 * 这样 `/api/agent/new` 不会被 `/api/agent/:id` 抢走，与表的书写顺序无关。
 */
export function matchApiRoute(method: string, pathname: string): ApiRouteMatch | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeSegment);

  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    if (route.segments.some((segment) => segment.startsWith(":"))) continue;
    if (route.segments.every((segment, index) => segment === parts[index])) {
      return { route, params: {} };
    }
  }

  for (const route of API_ROUTES) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index];
      if (segment.startsWith(":")) params[segment.slice(1)] = parts[index];
      else if (segment !== parts[index]) { matched = false; break; }
    }
    if (matched) return { route, params };
  }

  return null;
}
