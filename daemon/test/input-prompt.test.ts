import assert from 'node:assert/strict';
import test from 'node:test';
import {inputPromptAnnouncement} from '../src/input-prompt.js';

test('reads an ask_user question and its choices aloud', () => {
  const announcement = inputPromptAnnouncement('copilot', 'notification', {
    sessionId: 'copilot:session',
    notification_type: 'elicitation_dialog',
    toolCalls: [{
      id: 'call-1',
      name: 'ask_user',
      args: {
        question: 'Which database should I use?',
        choices: ['PostgreSQL', 'SQLite', 'MySQL'],
      },
    }],
  });
  assert.deepEqual(announcement, {
    key: 'copilot:session:Which database should I use? Options are PostgreSQL, SQLite, or MySQL.',
    text: 'Which database should I use? Options are PostgreSQL, SQLite, or MySQL.',
  });
});

test('supports JSON tool arguments and object choices', () => {
  const announcement = inputPromptAnnouncement('claude', 'notification', {
    session_id: 'session',
    notification_type: 'elicitation_dialog',
    toolName: 'AskUserQuestion',
    tool_input: JSON.stringify({
      questions: [{
        question: 'Choose a mode.',
        options: [{label: 'Safe'}, {label: 'Fast'}],
      }],
    }),
  });
  assert.equal(announcement?.text, 'Choose a mode. Options are Safe or Fast.');
});

test('reads Copilot toolArgs from the live hook shape', () => {
  const announcement = inputPromptAnnouncement('copilot', 'notification', {
    sessionId: 'session',
    notification_type: 'elicitation_dialog',
    toolName: 'ask_user',
    toolArgs: {
      question: 'Should I deploy this change?',
      choices: ['Deploy it', 'Keep testing'],
    },
  });
  assert.equal(announcement?.text,
    'Should I deploy this change? Options are Deploy it or Keep testing.');
});

test('uses concise questions for plan and permission requests', () => {
  assert.equal(inputPromptAnnouncement('copilot', 'notification', {
    sessionId: 'session',
    toolCalls: [{name: 'exit_plan_mode', args: {plan: 'Do not read this plan aloud.'}}],
  })?.text, 'Copilot has a plan ready. Would you like to approve it?');
  assert.equal(inputPromptAnnouncement('codex', 'notification', {
    sessionId: 'session',
    notification_type: 'permission_prompt',
  })?.text, 'Codex needs permission to continue. Would you like to approve the request?');
});

test('ignores non-input events and cleans unsafe speech formatting', () => {
  assert.equal(inputPromptAnnouncement('copilot', 'preToolUse', {
    sessionId: 'session',
    toolName: 'ask_user',
  }), null);
  assert.equal(inputPromptAnnouncement('copilot', 'notification', {
    sessionId: 'session',
    notification_type: 'elicitation_dialog',
    toolName: 'ask_user',
    question: 'Open [the docs](https://example.com) and check `status`.',
  })?.text, 'Open the docs and check status.');
});
