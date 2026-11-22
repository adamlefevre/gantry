import { TaskCoordinator, type Env } from "./TaskCoordinator";

export { TaskCoordinator };

/**
 * Every /api route needs `Authorization: Bearer <GANTRY_API_TOKEN>`. A started task spends
 * model tokens and sandbox time, so the Worker fails closed: with no token configured,
 * every /api request is refused.
 */
export function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.GANTRY_API_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer (.+)$/);
  return match !== null && timingSafeEqual(match[1], expected);
}

/** Compares in time that depends only on the lengths, so the token can't be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && !isAuthorized(request, env)) {
      return Response.json(
        { error: env.GANTRY_API_TOKEN ? "unauthorized" : "GANTRY_API_TOKEN is not configured" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
      );
    }

    // Route: /api/tasks/:id/start
    const startMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/start\/?$/);
    if (startMatch) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const taskId = startMatch[1];
      const id = env.TASK_COORDINATOR.idFromName(taskId);
      const stub = env.TASK_COORDINATOR.get(id);

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        // Body could be empty or invalid JSON
      }
      body.taskId = taskId;

      const doRequest = new Request(new URL("/start", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      return stub.fetch(doRequest);
    }

    // Route: /api/tasks/:id/ws
    const wsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/ws\/?$/);
    if (wsMatch) {
      const taskId = wsMatch[1];
      const id = env.TASK_COORDINATOR.idFromName(taskId);
      const stub = env.TASK_COORDINATOR.get(id);

      const doRequest = new Request(new URL("/ws", request.url), request);
      return stub.fetch(doRequest);
    }

    // Route: /api/tasks/:id/status
    const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status\/?$/);
    if (statusMatch) {
      const taskId = statusMatch[1];
      const id = env.TASK_COORDINATOR.idFromName(taskId);
      const stub = env.TASK_COORDINATOR.get(id);

      const doRequest = new Request(new URL("/status", request.url), request);
      return stub.fetch(doRequest);
    }

    // Route: /api/tasks/:id/steps
    const stepsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/steps\/?$/);
    if (stepsMatch) {
      const taskId = stepsMatch[1];
      const id = env.TASK_COORDINATOR.idFromName(taskId);
      const stub = env.TASK_COORDINATOR.get(id);

      const doRequest = new Request(new URL("/steps", request.url), request);
      return stub.fetch(doRequest);
    }

    return new Response("Not Found", { status: 404 });
  },
};
