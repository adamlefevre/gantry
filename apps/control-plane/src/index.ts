import { TaskCoordinator, type Env } from "./TaskCoordinator";

export { TaskCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
