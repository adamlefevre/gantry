import http from "node:http";
import type { AddressInfo } from "node:net";

/** Serves GET /repos/:owner/:repo/issues/:n from an in-memory map; everything else is 404. */
export class MockGitHubServer {
  private server: http.Server | null = null;
  public url = "";
  /** "owner/repo#n" → issue JSON as the REST API returns it. */
  public issues = new Map<string, Record<string, unknown>>();
  public requests: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  /** Set to make every request answer with this status (e.g. 403 for rate limiting). */
  public forceStatus: number | null = null;

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const path = req.url || "/";
        this.requests.push({ path, headers: req.headers });
        if (this.forceStatus) {
          res.writeHead(this.forceStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "forced" }));
          return;
        }
        const m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
        const issue = m && this.issues.get(`${m[1]}/${m[2]}#${m[3]}`);
        if (!issue) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(issue));
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
        resolve(this.url);
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
