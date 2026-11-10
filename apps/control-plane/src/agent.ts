import { generateText, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

const MODAL_ENDPOINT = process.env.MODAL_SANDBOX_URL || '';
const MODAL_AUTH_TOKEN = process.env.AGENT_SANDBOX_TOKEN || '';

async function callModal(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${MODAL_ENDPOINT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MODAL_AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Modal Sandbox Error [${res.status}]: ${await res.text()}`);
  }
  return res.json();
}

export async function runSelfHealingRepairAgent(bugDescription: string) {
  const { sandbox_id } = await callModal('/session/create', {});

  try {
    const result = await generateText({
      model: google(process.env.GEMINI_MODEL || 'gemini-1.5-pro'),
      maxSteps: 8,
      system: 'You are an automated repair agent. Use the isolated bash sandbox to reproduce, patch, and verify tests.',
      prompt: `Diagnose and fix the following issue:\n${bugDescription}`,
      tools: {
        runShellCommand: tool({
          description: 'Execute a bash command inside the Modal sandbox',
          parameters: z.object({
            command: z.string().describe('The command to run'),
          }),
          execute: async ({ command }) => {
            return await callModal('/exec', { sandbox_id, command, timeout_seconds: 45 });
          },
        }),
        writeFile: tool({
          description: 'Write or overwrite a file in the sandbox',
          parameters: z.object({
            path: z.string(),
            content: z.string(),
          }),
          execute: async ({ path, content }) => {
            return await callModal('/file/write', { sandbox_id, path, content });
          },
        }),
      },
    });

    const diff = await callModal('/exec', { sandbox_id, command: 'git diff || true' });

    return {
      summary: result.text,
      patch: diff.stdout,
      stepsTaken: result.steps.length,
    };
  } finally {
    await callModal('/session/terminate', { sandbox_id }).catch(console.error);
  }
}
