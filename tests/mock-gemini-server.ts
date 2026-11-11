import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted stand-in for the Gemini `generateContent` endpoint, so the control-plane tests
 * drive the real agent loop (AI SDK + @ai-sdk/google) without calling Google.
 *
 * The server is stateless per task: it picks a script by matching the task's prompt (the first
 * user message), and picks the turn by counting the model turns already in the request. That
 * keeps concurrent tasks from different tests apart without any shared queue.
 */

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One model reply. `status` answers with an HTTP error instead (e.g. 500 to fail the LLM call). */
export interface MockTurn {
  toolCalls?: MockToolCall[];
  text?: string;
  status?: number;
}

export interface GeminiRequest {
  model: string;
  apiKey: string | undefined;
  body: {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<Record<string, any>> }>;
    tools?: unknown;
  };
}

/** A turn, or a function that builds one from the request (to react to earlier tool results). */
export type ScriptStep = MockTurn | ((req: GeminiRequest) => MockTurn);

const DEFAULT_REPLY: MockTurn = { text: "Done." };

export class MockGeminiServer {
  private server: http.Server | null = null;
  public url = "";
  /** Prompt substring → the model's turns, in order. Past the end, the model answers DEFAULT_REPLY. */
  public scripts = new Map<string, ScriptStep[]>();
  public requests: GeminiRequest[] = [];

  /** Scripts the model for any task whose prompt contains `promptMarker`. */
  script(promptMarker: string, steps: ScriptStep[]): void {
    this.scripts.set(promptMarker, steps);
  }

  /** Requests made for the task whose prompt contains `promptMarker`, in order. */
  requestsFor(promptMarker: string): GeminiRequest[] {
    return this.requests.filter((r) => promptOf(r).includes(promptMarker));
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        let bodyText = "";
        for await (const chunk of req) bodyText += chunk;

        const m = (req.url || "").match(/\/models\/([^/:]+):generateContent/);
        if (req.method !== "POST" || !m) {
          return send(res, 404, { error: { code: 404, message: `Not found: ${req.url}`, status: "NOT_FOUND" } });
        }

        const request: GeminiRequest = {
          model: m[1],
          apiKey: req.headers["x-goog-api-key"] as string | undefined,
          body: JSON.parse(bodyText),
        };
        this.requests.push(request);

        const turn = this.turnFor(request);
        if (turn.status) {
          return send(res, turn.status, {
            error: { code: turn.status, message: "Scripted failure", status: "INTERNAL" },
          });
        }

        const parts: Array<Record<string, unknown>> = [];
        if (turn.text) parts.push({ text: turn.text });
        for (const call of turn.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.args } });

        send(res, 200, {
          candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        });
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

  private turnFor(request: GeminiRequest): MockTurn {
    const prompt = promptOf(request);
    const steps = [...this.scripts.entries()].find(([marker]) => prompt.includes(marker))?.[1];
    const index = request.body.contents.filter((c) => c.role === "model").length;
    const step = steps?.[index];
    if (!step) return DEFAULT_REPLY;
    return typeof step === "function" ? step(request) : step;
  }
}

/** The task prompt: the text of the first user message. */
export function promptOf(request: GeminiRequest): string {
  const first = request.body.contents.find((c) => c.role === "user");
  return (first?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** Tool results the loop sent back in this request, oldest first, as `{name, result}`. */
export function toolResultsIn(request: GeminiRequest): Array<{ name: string; result: any }> {
  return request.body.contents.flatMap((c) =>
    c.parts
      .filter((p) => p.functionResponse)
      .map((p) => ({ name: p.functionResponse.name as string, result: p.functionResponse.response?.content }))
  );
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
