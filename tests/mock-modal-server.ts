import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockSession {
  id: string;
  taskId?: string;
  repoUrl?: string;
  ref?: string;
  files: Map<string, string>;
  commands: string[];
  terminated: boolean;
  createdAt: number;
}

export interface MockRequestLog {
  endpoint: string;
  body: Record<string, any>;
  timestamp: number;
}

export class MockModalServer {
  private server: http.Server | null = null;
  public sessions: Map<string, MockSession> = new Map();
  public requests: MockRequestLog[] = [];
  public port: number = 0;
  public url: string = "";

  constructor() {}

  async start(preferredPort: number = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
          const pathname = url.pathname;

          let bodyText = "";
          for await (const chunk of req) {
            bodyText += chunk;
          }

          let body: Record<string, any> = {};
          if (bodyText) {
            try {
              body = JSON.parse(bodyText);
            } catch {
              body = { raw: bodyText };
            }
          }

          this.requests.push({
            endpoint: pathname,
            body,
            timestamp: Date.now(),
          });

          // Route: /session/create
          if (pathname === "/session/create" && req.method === "POST") {
            const sessionId = `sb_${Math.random().toString(36).substring(2, 10)}`;
            const session: MockSession = {
              id: sessionId,
              taskId: body.taskId,
              repoUrl: body.repo_url,
              ref: body.ref,
              files: new Map(),
              commands: [],
              terminated: false,
              createdAt: Date.now(),
            };
            this.sessions.set(sessionId, session);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionId, sandbox_id: sessionId }));
            return;
          }

          const sessionId = body.sessionId || body.sandbox_id;
          const session = sessionId ? this.sessions.get(sessionId) : undefined;

          // Route: /exec
          if (pathname === "/exec" && req.method === "POST") {
            const command = (body.command as string) || "";
            if (session) {
              session.commands.push(command);
            }

            let stdout = "";
            let exitCode = 0;

            if (command.includes("pytest")) {
              stdout = [
                "============================= test session starts ==============================",
                "platform linux -- Python 3.11.8, pytest-8.1.1, pluggy-1.4.0",
                "rootdir: /workspace",
                "collected 1 item",
                "",
                "tests/test_compaction.py .                                               [100%]",
                "",
                "============================== 1 passed in 0.12s ===============================",
              ].join("\n");
            } else if (command.includes("git diff")) {
              if (session && session.files.size > 0) {
                const diffLines: string[] = [];
                for (const [path, content] of session.files.entries()) {
                  diffLines.push(
                    `diff --git a/${path} b/${path}`,
                    `--- a/${path}`,
                    `+++ b/${path}`,
                    `@@ -1,0 +1,${content.split("\n").length} @@`,
                    ...content.split("\n").map((line) => `+${line}`)
                  );
                }
                stdout = diffLines.join("\n");
              } else {
                stdout = [
                  "diff --git a/pipelines/compact.py b/pipelines/compact.py",
                  "index e69de29..b123456 100644",
                  "--- a/pipelines/compact.py",
                  "+++ b/pipelines/compact.py",
                  "@@ -25,3 +25,4 @@ def compact_partition():",
                  "+    # Patched by Gantry agent for target ~128MB bin packing",
                ].join("\n");
              }
            } else if (command.includes("git status")) {
              stdout = "On branch main\nnothing to commit, working tree clean\n";
            } else {
              stdout = `Executed: ${command}\n`;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                sandbox_id: sessionId || "sb_default",
                sessionId: sessionId || "sb_default",
                exit_code: exitCode,
                stdout,
                stderr: "",
              })
            );
            return;
          }

          // Route: /file/write
          if (pathname === "/file/write" && req.method === "POST") {
            const { path, content } = body;
            if (session && path) {
              session.files.set(path, content ?? "");
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", path }));
            return;
          }

          // Route: /file/read
          if (pathname === "/file/read" && req.method === "POST") {
            const { path } = body;
            const content = session?.files.get(path) ?? `# Mock content for ${path}\n`;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", path, content }));
            return;
          }

          // Route: /session/terminate
          if (pathname === "/session/terminate" && req.method === "POST") {
            if (session) {
              session.terminated = true;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "terminated" }));
            return;
          }

          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Endpoint not found", pathname }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.listen(preferredPort, "127.0.0.1", () => {
        const addr = this.server?.address() as AddressInfo;
        this.port = addr.port;
        this.url = `http://127.0.0.1:${this.port}`;
        resolve(this.url);
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  isSessionTerminated(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.terminated : false;
  }

  allSessionsTerminated(): boolean {
    if (this.sessions.size === 0) return false;
    for (const session of this.sessions.values()) {
      if (!session.terminated) return false;
    }
    return true;
  }
}
