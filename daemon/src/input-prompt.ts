import type {AgentId} from './agents/types.js';
import type {HookEvent, HookPayload} from './protocol.js';

const maxPromptCharacters = 600;
const questionTools = new Set(['ask_user', 'askuserquestion', 'clarify']);
const planTools = new Set(['exit_plan_mode', 'exitplanmode']);
const agentNames: Record<AgentId, string> = {
  copilot: 'Copilot',
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
};

export interface InputPromptAnnouncement {
  key: string;
  text: string;
}

export function inputPromptAnnouncement(
    agent: AgentId, event: HookEvent, payload: HookPayload): InputPromptAnnouncement | null {
  if (event !== 'notification') return null;
  const call = inputToolCall(payload);
  const tool = normalizedToolName(call?.name ?? payload.toolName ?? payload.tool_name);
  const source = agentNames[agent];
  let text: string | null = null;

  if (questionTools.has(tool)) {
    const input = objectValue(call?.args) ?? objectValue(call?.arguments)
      ?? objectValue(call?.input) ?? objectValue(payload.toolArgs)
      ?? objectValue(payload.toolInput) ?? objectValue(payload.tool_input)
      ?? objectValue(payload.args) ?? objectValue(payload.arguments) ?? objectValue(payload.input);
    text = questionText(input, payload) ?? `${source} needs your input. Please review the question in the app.`;
  } else if (planTools.has(tool)) {
    text = `${source} has a plan ready. Would you like to approve it?`;
  } else {
    const type = String(payload.notification_type ?? '').toLowerCase();
    const question = firstText(payload.question, payload.prompt);
    if (question) text = cleanSpeech(question);
    else if (type === 'permission_prompt')
      text = `${source} needs permission to continue. Would you like to approve the request?`;
    else if (['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type))
      text = `${source} needs your input. Please review the question in the app.`;
  }

  if (!text) return null;
  const session = firstText(payload.sessionId, payload.session_id) ?? 'unknown';
  const sessionKey = session.startsWith(`${agent}:`) ? session : `${agent}:${session}`;
  return {key: `${sessionKey}:${text}`, text};
}

function inputToolCall(payload: HookPayload): Record<string, unknown> | null {
  if (!Array.isArray(payload.toolCalls)) return null;
  for (const value of payload.toolCalls) {
    const call = objectValue(value);
    if (!call) continue;
    const tool = normalizedToolName(call.name);
    if (questionTools.has(tool) || planTools.has(tool)) return call;
  }
  return null;
}

function questionText(input: Record<string, unknown> | null, payload: HookPayload): string | null {
  const nested = Array.isArray(input?.questions) ? objectValue(input.questions[0]) : null;
  const question = firstText(
    input?.question,
    nested?.question,
    payload.question,
    payload.prompt,
  );
  if (!question) return null;
  const choices = choiceTexts(input?.choices ?? input?.options ?? nested?.choices ?? nested?.options);
  return cleanSpeech(choices.length ? `${question} Options are ${naturalList(choices)}.` : question);
}

function choiceTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const choices: string[] = [];
  for (const item of value) {
    const record = objectValue(item);
    const text = firstText(item, record?.label, record?.name, record?.value);
    if (text) choices.push(cleanSpeech(text));
    if (choices.length === 5) break;
  }
  return choices.filter(Boolean);
}

function naturalList(values: string[]): string {
  if (values.length < 2) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

function cleanSpeech(value: string): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[`*_#<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
  if (cleaned.length <= maxPromptCharacters) return cleaned;
  return `${cleaned.slice(0, maxPromptCharacters - 3).trimEnd()}...`;
}

function normalizedToolName(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', '_').toLowerCase() : '';
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
