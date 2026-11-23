import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted stand-in for the Anthropic Messages API (`POST /v1/messages`), so the control-plane
 * tests drive the real agent loop (the official @anthropic-ai/sdk client) without calling Anthropic.
 *
 * The server is stateless per task: it picks a script by matching the task's prompt (the first
 * user message), and picks the turn by counting the assistant turns already in the request. That
 * keeps concurrent tasks from different tests apart without any shared queue.
 *
 * Every reply starts with a thinking block, as Claude Opus 5.5's always do, so the tests can check
 * that the loop sends each assistant turn back unchanged.
 */

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One model reply. `status` answers with an HTTP error instead (e.g. 400 to fail the model call). */
export interface MockTurn {
  toolCalls?: MockToolCall[];
  text?: string;
  status?: number;
  /** Defaults to "tool_use" when the turn calls tools, else "end_turn". */
  stopReason?: string;
  /** Wait this long before answering, to keep a task running while a test acts on it. */
  delayMs?: number;
}

type Block = Record<string, any>;

export interface AnthropicRequest {
  path: string;
  apiKey: string | undefined;
  /** The anthropic-beta header, if any. */
  beta: string | undefined;
  model: string;
  body: {
    model: string;
    system?: string | Array<{ text: string }>;
    messages: Array<{ role: string; content: string | Block[] }>;
    tools?: Array<{ name: string }>;
    [key: string]: unknown;
  };
}

/** A turn, or a function that builds one from the request (to react to earlier tool results). */
export type ScriptStep = MockTurn | ((req: AnthropicRequest) => MockTurn);

const DEFAULT_REPLY: MockTurn = { text: "Done." };

export class MockAnthropicServer {
  private server: http.Server | null = null;
  public url = "";
  /** Prompt substring → the model's turns, in order. Past the end, the model answers DEFAULT_REPLY. */
  public scripts = new Map<string, ScriptStep[]>();
  public requests: AnthropicRequest[] = [];

  /** Scripts the model for any task whose prompt contains `promptMarker`. */
  script(promptMarker: string, steps: ScriptStep[]): void {
    this.scripts.set(promptMarker, steps);
  }

  /** Requests made for the task whose prompt contains `promptMarker`, in order. */
  requestsFor(promptMarker: string): AnthropicRequest[] {
    return this.requests.filter((r) => promptOf(r).includes(promptMarker));
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        let bodyText = "";
        for await (const chunk of req) bodyText += chunk;

        const path = (req.url || "").split("?")[0];
        if (req.method !== "POST" || path !== "/v1/messages") {
          return sendError(res, 404, "not_found_error", `Not found: ${req.url}`);
        }

        const body = JSON.parse(bodyText) as AnthropicRequest["body"];
        const request: AnthropicRequest = {
          path: req.url || "",
          apiKey: apiKeyOf(req),
          beta: req.headers["anthropic-beta"] as string | undefined,
          model: body.model,
          body,
        };
        this.requests.push(request);

        const index = request.body.messages.filter((m) => m.role === "assistant").length;
        const turn = this.turnFor(request, index);
        if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
        if (turn.status) {
          return sendError(res, turn.status, "invalid_request_error", "Scripted failure");
        }

        const content: Block[] = [{ type: "thinking", thinking: "", signature: `sig-${index}` }];
        if (turn.text) content.push({ type: "text", text: turn.text });
        (turn.toolCalls ?? []).forEach((call, i) =>
          content.push({ type: "tool_use", id: `toolu_${index}_${i}`, name: call.name, input: call.args })
        );

        send(res, 200, {
          id: `msg_mock_${this.requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content,
          stop_reason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn"),
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

  private turnFor(request: AnthropicRequest, index: number): MockTurn {
    const prompt = promptOf(request);
    const steps = [...this.scripts.entries()].find(([marker]) => prompt.includes(marker))?.[1];
    const step = steps?.[index];
    if (!step) return DEFAULT_REPLY;
    return typeof step === "function" ? step(request) : step;
  }
}

function blocksOf(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** The task prompt: the text of the first user message. */
export function promptOf(request: AnthropicRequest): string {
  const first = request.body.messages.find((m) => m.role === "user");
  return first ? blocksOf(first.content).map((b) => b.text ?? "").join("") : "";
}

/** Tool results the loop sent back in this request, oldest first, as `{name, result, isError}`. */
export function toolResultsIn(request: AnthropicRequest): Array<{ name: string; result: any; isError: boolean }> {
  const names = new Map<string, string>();
  const results: Array<{ name: string; result: any; isError: boolean }> = [];
  for (const message of request.body.messages) {
    for (const block of blocksOf(message.content)) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : blocksOf(block.content).map((b) => b.text).join("");
        results.push({ name: names.get(block.tool_use_id) ?? "?", result: JSON.parse(text), isError: block.is_error === true });
      }
    }
  }
  return results;
}

/** The key the client sent. The 1.x SDK sends it as a bearer token; older clients used x-api-key. */
function apiKeyOf(req: http.IncomingMessage): string | undefined {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return bearer ?? (req.headers["x-api-key"] as string | undefined);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  send(res, status, { type: "error", error: { type, message } });
}
