import { describe, it, expect, beforeAll, afterAll } from "vitest";
import agentConfigFile from "../agent-config.json";
import {
  AgentConfigError,
  canonicalJson,
  fillTemplate,
  parseAgentConfig,
  resolveAgentConfig
} from "../src/agentConfig";
import { runAgentLoop, buildSystemPrompt } from "../src/agent";
import { MockModalServer } from "./mock-modal-server";
import { MockAnthropicServer } from "./mock-anthropic-server";

const clone = () => JSON.parse(JSON.stringify(agentConfigFile));

describe("agent-config.json", () => {
  it("is valid", () => {
    expect(() => parseAgentConfig(agentConfigFile)).not.toThrow();
  });

  it("gives the same hash whatever the key order, and leaves the comment out of it", async () => {
    const a = await resolveAgentConfig({}, agentConfigFile);
    const reordered = Object.fromEntries(Object.entries(clone()).reverse());
    const b = await resolveAgentConfig({}, { ...reordered, $comment: "changed" });
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.version).toBe(agentConfigFile.version);
  });

  it("changes the hash when the prompt, a budget, or an override changes", async () => {
    const base = (await resolveAgentConfig({}, agentConfigFile)).hash;
    const prompt = clone();
    prompt.systemPrompt.task = ["Fix it."];
    const budget = clone();
    budget.budgets.maxTurns = 8;
    expect((await resolveAgentConfig({}, prompt)).hash).not.toBe(base);
    expect((await resolveAgentConfig({}, budget)).hash).not.toBe(base);
    const overridden = await resolveAgentConfig({ model: "claude-sonnet-5-5", effort: "low" }, agentConfigFile);
    expect(overridden.hash).not.toBe(base);
    expect(overridden.config).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  });

  it("rejects an unknown effort, an unknown tool, no tools, and unknown keys", async () => {
    await expect(resolveAgentConfig({ effort: "extreme" }, agentConfigFile)).rejects.toThrow(AgentConfigError);
    const unknownTool = clone();
    unknownTool.tools.deleteRepo = ["Delete it"];
    expect(() => parseAgentConfig(unknownTool)).toThrow(/tools/);
    expect(() => parseAgentConfig({ ...clone(), tools: {} })).toThrow(/at least one tool/);
    expect(() => parseAgentConfig({ ...clone(), temperature: 0 })).toThrow(AgentConfigError);
    const badBudget = clone();
    badBudget.budgets.maxTurns = 0;
    expect(() => parseAgentConfig(badBudget)).toThrow(/budgets.maxTurns/);
  });

  it("fills only the placeholders it is given", () => {
    expect(fillTemplate(["Run `{testCommand}`", "keep {other} and {\"json\": 1}"], { testCommand: "npm test" })).toBe(
      'Run `npm test`\nkeep {other} and {"json": 1}'
    );
  });

  it("sorts keys in canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });

  it("builds the system prompt from the config's sections", () => {
    const config = clone();
    config.systemPrompt.intro = ["You are a test agent."];
    const p = buildSystemPrompt({ repo: { url: "https://github.com/octo/widgets", ref: "main" } }, config);
    expect(p.split("\n")[0]).toBe("You are a test agent.");
    expect(p).toContain("https://github.com/octo/widgets (ref main)");
    expect(p).toContain("cannot be verified");
  });
});

describe("runAgentLoop with a candidate config", () => {
  let modal: MockModalServer;
  let anthropic: MockAnthropicServer;

  beforeAll(async () => {
    modal = new MockModalServer();
    await modal.start();
    anthropic = new MockAnthropicServer();
    await anthropic.start();
  });

  afterAll(async () => {
    await modal?.stop();
    await anthropic?.stop();
  });

  const env = () =>
    ({
      MODAL_SANDBOX_URL: modal.url,
      AGENT_SANDBOX_TOKEN: "mock-token",
      ANTHROPIC_API_KEY: "mock-key",
      ANTHROPIC_BASE_URL: anthropic.url
    }) as any;

  const run = (marker: string, agentConfig: unknown) =>
    runAgentLoop({
      env: env(),
      prompt: `${marker} fix it`,
      taskId: marker,
      agentConfig,
      onStep: () => {},
      onChunk: () => {}
    });

  it("offers only the config's tools, with its descriptions", async () => {
    const marker = "[config-tools]";
    anthropic.script(marker, [{ text: "Done." }]);
    const config = clone();
    delete config.tools.writeFile;
    config.tools.runCommand = ["Run a shell command."];
    const telemetry = await run(marker, config);

    const [request] = anthropic.requestsFor(marker);
    const tools = request.body.tools as Array<{ name: string; description?: string }>;
    expect(tools.map((t) => t.name)).toEqual(["runCommand", "readFile", "editFile", "getDiff"]);
    expect(tools[0].description).toBe("Run a shell command.");
    expect(telemetry.agentConfigVersion).toBe(agentConfigFile.version);
  });

  it("stops at the turn budget and at the token budget, keeping the patch", async () => {
    const turns = Array.from({ length: 6 }, () => ({ toolCalls: [{ name: "runCommand", args: { command: "ls" } }] }));

    const byTurns = clone();
    byTurns.budgets.maxTurns = 3;
    anthropic.script("[config-turns]", turns);
    await run("[config-turns]", byTurns);
    expect(anthropic.requestsFor("[config-turns]")).toHaveLength(3);

    // Each mock turn uses 15 tokens, so a 30-token budget is spent after the second turn.
    const byTokens = clone();
    byTokens.budgets.maxTotalTokens = 30;
    anthropic.script("[config-tokens]", turns);
    const telemetry = await run("[config-tokens]", byTokens);
    expect(anthropic.requestsFor("[config-tokens]")).toHaveLength(2);
    expect(telemetry.totalTokens).toBe(30);
    // The second turn's tool call isn't run once the budget is spent.
    expect(telemetry.stepsCount).toBe(1);
    expect(typeof telemetry.patch).toBe("string");
  });

  it("fails before starting a sandbox when the config is invalid", async () => {
    await expect(run("[config-invalid]", { ...clone(), version: "" })).rejects.toThrow(AgentConfigError);
    expect([...modal.sessions.values()].some((s) => s.taskId === "[config-invalid]")).toBe(false);
  });
});
