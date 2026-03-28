import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { StreamEventBuffer, summarizeOutput } from '../../lib/tasks/stream-event-buffer.ts';
import type { TaskEvent } from '../../lib/tasks/types.ts';

// ─── Helpers ───────────────────────────────────────────────────────────
type RawEvent = { type: string; content?: string; tool?: string; input?: unknown; output?: unknown };

/** Simulate the Agent CEO streaming pattern: per-token events from agent-executor */
function simulateAgentCEOStream(): RawEvent[] {
  const events: RawEvent[] = [];

  // Phase 1: Thinking tokens (per-token, avg ~4 chars each — simulating 290 tokens)
  const thinkingText = 'I need to review the organization status. Let me check the current tickets, assess priorities, and determine the best course of action for each one. First, I will look at blocked tickets and try to unblock them. Then review in-progress work and finally prioritize backlog items.';
  for (let i = 0; i < thinkingText.length; i += 4) {
    events.push({ type: 'thinking', content: thinkingText.slice(i, i + 4) });
  }

  // Phase 2: Tool call — list_tickets
  events.push({ type: 'tool_start', tool: 'list_tickets', input: { orgId: 'org-1' } });
  events.push({ type: 'tool_end', tool: 'list_tickets', output: JSON.stringify([
    { id: '1', title: 'Fix auth bug', status: 'in_progress' },
    { id: '2', title: 'Add dashboard', status: 'backlog' },
  ]) });

  // Phase 3: More thinking tokens
  const thinking2 = 'Good, I see the tickets. The auth bug is in progress. Let me check on that and prioritize the dashboard ticket.';
  for (let i = 0; i < thinking2.length; i += 3) {
    events.push({ type: 'thinking', content: thinking2.slice(i, i + 3) });
  }

  // Phase 4: Tool call — update_ticket
  events.push({ type: 'tool_start', tool: 'update_ticket', input: { id: '2', status: 'todo', priority: 'high' } });
  events.push({ type: 'tool_end', tool: 'update_ticket', output: 'ok' });

  // Phase 5: Content tokens (response text, per-token)
  const contentText = '## Status Report\n\nI reviewed the org board. The auth bug fix is in progress. I promoted the dashboard task to high priority and moved it to todo.\n\n## Handoff Notes\n- Auth bug in progress, check next heartbeat\n- Dashboard task ready for assignment';
  for (let i = 0; i < contentText.length; i += 5) {
    events.push({ type: 'content', content: contentText.slice(i, i + 5) });
  }

  // Phase 6: Tool call — assign_agent
  events.push({ type: 'tool_start', tool: 'assign_agent', input: { ticket: '2', agent: 'frontend-dev' } });
  events.push({ type: 'tool_end', tool: 'assign_agent', output: 'assigned' });

  // Phase 7: Final content tokens
  const finalContent = 'Agent frontend-dev has been assigned to the dashboard task.';
  for (let i = 0; i < finalContent.length; i += 4) {
    events.push({ type: 'content', content: finalContent.slice(i, i + 4) });
  }

  // Phase 8: Usage event
  events.push({ type: 'usage', input_tokens: 1500, output_tokens: 800 } as any);

  return events;
}

/** Simulate the Claude Code CEO streaming pattern: pre-aggregated blocks from stream-json */
function simulateClaudeCodeCEOStream(): RawEvent[] {
  return [
    // Block 1: Full thinking block (already aggregated by Claude CLI)
    { type: 'thinking', content: 'I need to review the organization status. Let me check the current tickets, assess priorities, and determine the best course of action. First, blocked tickets, then in-progress work.' },
    // Block 2: Tool call
    { type: 'tool_start', tool: 'Bash', input: 'curl -s http://localhost:3000/api/organizations/tickets?orgId=org-1' },
    { type: 'tool_end', tool: '', output: '[{"id":"1","title":"Fix auth bug","status":"in_progress"},{"id":"2","title":"Add dashboard","status":"backlog"}]' },
    // Block 3: Another thinking block
    { type: 'thinking', content: 'Good, I see the tickets. The auth bug is in progress. Let me prioritize the dashboard ticket and assign an agent.' },
    // Block 4: Another tool call
    { type: 'tool_start', tool: 'Bash', input: 'curl -X PATCH http://localhost:3000/api/organizations/tickets/2 -d \'{"status":"todo","priority":"high"}\'' },
    { type: 'tool_end', tool: '', output: '{"ok":true}' },
    // Block 5: Full content block
    { type: 'content', content: '## Status Report\n\nI reviewed the org board. The auth bug fix is in progress. I promoted the dashboard task to high priority.\n\n## Handoff Notes\n- Auth bug in progress\n- Dashboard task assigned to frontend-dev' },
  ];
}

/** Simulate a model that does NOT produce thinking tokens (e.g., GPT-4o, Gemini) */
function simulateNoThinkingModelStream(): RawEvent[] {
  const events: RawEvent[] = [];

  // Straight to content tokens
  const text = 'Here is my analysis of the situation. I will perform the following actions.';
  for (let i = 0; i < text.length; i += 6) {
    events.push({ type: 'content', content: text.slice(i, i + 6) });
  }

  events.push({ type: 'tool_start', tool: 'search', input: { q: 'bugs' } });
  events.push({ type: 'tool_end', tool: 'search', output: 'found 3 bugs' });

  const response = 'I found 3 bugs and have prioritized them accordingly.';
  for (let i = 0; i < response.length; i += 8) {
    events.push({ type: 'content', content: response.slice(i, i + 8) });
  }

  return events;
}

/** Simulate a verbose thinking model (e.g., Claude with extended thinking) that thinks heavily */
function simulateHeavyThinkingModelStream(): RawEvent[] {
  const events: RawEvent[] = [];

  // Very long thinking (simulating 500 tokens of extended thinking)
  const longThinking = 'Let me think carefully about this. '.repeat(50);
  for (let i = 0; i < longThinking.length; i += 3) {
    events.push({ type: 'thinking', content: longThinking.slice(i, i + 3) });
  }

  // Tiny content response
  events.push({ type: 'content', content: 'Done.' });

  return events;
}

/** Simulate rapid alternation between thinking and content (some models do this) */
function simulateRapidTypeAlternation(): RawEvent[] {
  const events: RawEvent[] = [];
  for (let i = 0; i < 20; i++) {
    events.push({ type: 'thinking', content: `think${i} ` });
    events.push({ type: 'content', content: `say${i} ` });
  }
  return events;
}

/** Simulate multiple tool calls in sequence without content between them */
function simulateConsecutiveToolCalls(): RawEvent[] {
  return [
    { type: 'thinking', content: 'I need to run several commands.' },
    { type: 'tool_start', tool: 'list_agents', input: {} },
    { type: 'tool_end', tool: 'list_agents', output: '["agent-a","agent-b"]' },
    { type: 'tool_start', tool: 'list_tickets', input: { orgId: '1' } },
    { type: 'tool_end', tool: 'list_tickets', output: '[]' },
    { type: 'tool_start', tool: 'create_ticket', input: { title: 'Setup CI' } },
    { type: 'tool_end', tool: 'create_ticket', output: '{"id":"t1"}' },
    { type: 'content', content: 'All done. Created a new ticket for CI setup.' },
  ];
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('StreamEventBuffer', () => {
  let emitted: TaskEvent[];
  let buffer: StreamEventBuffer;

  beforeEach(() => {
    emitted = [];
    buffer = new StreamEventBuffer((event) => emitted.push(event));
  });

  // ── Core behavior ──

  it('should accumulate content tokens into a single event on flush', () => {
    buffer.push({ type: 'content', content: 'Hello' });
    buffer.push({ type: 'content', content: ' world' });
    buffer.push({ type: 'content', content: '!' });
    assert.equal(emitted.length, 0);
    buffer.flush();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'content');
    assert.equal(emitted[0].content, 'Hello world!');
  });

  it('should accumulate thinking tokens into a single event on flush', () => {
    buffer.push({ type: 'thinking', content: 'Let me ' });
    buffer.push({ type: 'thinking', content: 'think about this.' });
    buffer.flush();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'thinking');
    assert.equal(emitted[0].content, 'Let me think about this.');
  });

  it('should flush when event type changes from thinking to content', () => {
    buffer.push({ type: 'thinking', content: 'reasoning here' });
    buffer.push({ type: 'content', content: 'answer here' });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'thinking');
    assert.equal(emitted[0].content, 'reasoning here');
    buffer.flush();
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].type, 'content');
    assert.equal(emitted[1].content, 'answer here');
  });

  it('should flush text before tool_start and emit tool event immediately', () => {
    buffer.push({ type: 'content', content: 'before tool' });
    buffer.push({ type: 'tool_start', tool: 'search', input: { q: 'test' } });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].type, 'content');
    assert.equal(emitted[0].content, 'before tool');
    assert.equal(emitted[1].type, 'tool_start');
    assert.equal(emitted[1].tool, 'search');
    assert.deepEqual(emitted[1].input, { q: 'test' });
  });

  it('should flush text before tool_end and include output', () => {
    buffer.push({ type: 'content', content: 'some text' });
    buffer.push({ type: 'tool_end', tool: 'search', output: 'result' });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].type, 'content');
    assert.equal(emitted[1].type, 'tool_end');
    assert.equal(emitted[1].output, 'result');
  });

  it('should deduplicate repeated identical thinking blocks', () => {
    buffer.push({ type: 'thinking', content: 'same thought' });
    buffer.flush();
    buffer.push({ type: 'thinking', content: 'same thought' });
    buffer.flush();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].content, 'same thought');
  });

  it('should not deduplicate different thinking blocks', () => {
    buffer.push({ type: 'thinking', content: 'thought A' });
    buffer.flush();
    buffer.push({ type: 'thinking', content: 'thought B' });
    buffer.flush();
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].content, 'thought A');
    assert.equal(emitted[1].content, 'thought B');
  });

  it('should ignore empty or whitespace-only content', () => {
    buffer.push({ type: 'content', content: '' });
    buffer.push({ type: 'content', content: '   ' });
    buffer.flush();
    assert.equal(emitted.length, 0);
  });

  it('should handle missing content field gracefully', () => {
    buffer.push({ type: 'content' });
    buffer.push({ type: 'content', content: 'real text' });
    buffer.flush();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].content, 'real text');
  });

  it('should flush on unknown event types without storing them', () => {
    buffer.push({ type: 'content', content: 'buffered' });
    buffer.push({ type: 'react_iteration' } as any);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'content');
    assert.equal(emitted[0].content, 'buffered');
  });

  it('should handle double flush without emitting duplicates', () => {
    buffer.push({ type: 'content', content: 'only once' });
    buffer.flush();
    buffer.flush();
    assert.equal(emitted.length, 1);
  });

  it('should set timestamps on all events', () => {
    buffer.push({ type: 'content', content: 'text' });
    buffer.push({ type: 'tool_start', tool: 'x' });
    buffer.flush();
    for (const evt of emitted) {
      assert.ok(evt.timestamp > 0, `event ${evt.type} should have a timestamp`);
    }
  });

  // ── Tool event field preservation ──

  it('should preserve tool name on tool_start', () => {
    buffer.push({ type: 'tool_start', tool: 'my_tool' });
    assert.equal(emitted[0].tool, 'my_tool');
  });

  it('should preserve input on tool_start', () => {
    buffer.push({ type: 'tool_start', tool: 'x', input: { key: 'val' } });
    assert.deepEqual(emitted[0].input, { key: 'val' });
  });

  it('should preserve output on tool_end', () => {
    buffer.push({ type: 'tool_end', tool: 'x', output: { result: true } });
    assert.deepEqual(emitted[0].output, { result: true });
  });

  it('should omit undefined fields on tool events', () => {
    buffer.push({ type: 'tool_start' });
    assert.equal(emitted[0].tool, undefined);
    assert.equal(emitted[0].input, undefined);
  });

  it('should summarize large tool output via summarizeOutput', () => {
    const bigOutput = 'x'.repeat(600);
    buffer.push({ type: 'tool_end', tool: 'search', output: bigOutput });
    const result = emitted[0].output as string;
    assert.equal(result.length, 503);
    assert.ok(result.endsWith('...'));
  });

  it('should summarize image data in tool output arrays', () => {
    buffer.push({
      type: 'tool_end',
      tool: 'screenshot',
      output: [
        { type: 'image', mediaType: 'image/png', data: 'a'.repeat(50000) },
        { type: 'text', text: 'A screenshot' },
      ],
    });
    const output = emitted[0].output as any[];
    assert.equal(output[0].type, 'image');
    assert.equal(output[0].bytes, 50000);
    assert.equal(output[0].data, undefined);
    assert.equal(output[1].text, 'A screenshot');
  });

  // ── Agent CEO simulation (per-token streaming) ──

  describe('Agent CEO pattern (per-token)', () => {
    it('should compress 150+ per-token events into <15 buffered events', () => {
      const rawEvents = simulateAgentCEOStream();
      assert.ok(rawEvents.length > 150, `Expected >150 raw events, got ${rawEvents.length}`);

      for (const evt of rawEvents) {
        buffer.push(evt);
      }
      buffer.flush();

      // Expected: thinking1 + tool_start + tool_end + thinking2 + tool_start + tool_end +
      //           content1 + tool_start + tool_end + content2 = 10
      // (usage event flushes content but doesn't store itself)
      assert.ok(emitted.length <= 15, `Expected <=15 events, got ${emitted.length}`);
      assert.ok(emitted.length >= 8, `Expected >=8 events, got ${emitted.length}`);

      // Verify event types in order
      assert.equal(emitted[0].type, 'thinking');
      assert.ok(emitted[0].content!.length > 100, 'Thinking block should be full paragraph');
    });

    it('should preserve all text content without loss', () => {
      const rawEvents = simulateAgentCEOStream();
      for (const evt of rawEvents) {
        buffer.push(evt);
      }
      buffer.flush();

      // Reconstruct text from buffered thinking events
      const thinkingText = emitted.filter(e => e.type === 'thinking').map(e => e.content).join('');
      const contentText = emitted.filter(e => e.type === 'content').map(e => e.content).join('');

      // Reconstruct text from raw events
      const rawThinking = rawEvents.filter(e => e.type === 'thinking').map(e => e.content).join('');
      const rawContent = rawEvents.filter(e => e.type === 'content').map(e => e.content).join('');

      assert.equal(thinkingText, rawThinking.trim());
      assert.equal(contentText, rawContent.trim());
    });

    it('should preserve all tool events unchanged', () => {
      const rawEvents = simulateAgentCEOStream();
      for (const evt of rawEvents) {
        buffer.push(evt);
      }
      buffer.flush();

      const toolStarts = emitted.filter(e => e.type === 'tool_start');
      const toolEnds = emitted.filter(e => e.type === 'tool_end');
      const rawToolStarts = rawEvents.filter(e => e.type === 'tool_start');

      assert.equal(toolStarts.length, rawToolStarts.length);
      assert.equal(toolEnds.length, rawToolStarts.length);

      // Verify tool names preserved
      for (let i = 0; i < toolStarts.length; i++) {
        assert.equal(toolStarts[i].tool, rawToolStarts[i].tool);
      }
    });
  });

  // ── Claude Code CEO simulation (pre-aggregated) ──

  describe('Claude Code CEO pattern (pre-aggregated)', () => {
    it('should pass through pre-aggregated events with similar count', () => {
      const rawEvents = simulateClaudeCodeCEOStream();
      for (const evt of rawEvents) {
        buffer.push(evt);
      }
      buffer.flush();

      // Claude Code events are already coarse-grained, so buffer should produce
      // roughly the same number of events (minus deduplication)
      assert.ok(emitted.length <= rawEvents.length + 1, `Should not inflate: ${emitted.length} vs ${rawEvents.length}`);
      assert.ok(emitted.length >= rawEvents.length - 2, `Should not lose events: ${emitted.length} vs ${rawEvents.length}`);
    });

    it('should preserve full text blocks from Claude Code CEO', () => {
      const rawEvents = simulateClaudeCodeCEOStream();
      for (const evt of rawEvents) {
        buffer.push(evt);
      }
      buffer.flush();

      const contentEvents = emitted.filter(e => e.type === 'content');
      assert.ok(contentEvents.length >= 1);
      // The content block should contain the full status report
      const fullContent = contentEvents.map(e => e.content).join('');
      assert.ok(fullContent.includes('Status Report'));
      assert.ok(fullContent.includes('Handoff Notes'));
    });
  });

  // ── Cross-CEO parity ──

  describe('Agent CEO vs Claude Code CEO parity', () => {
    it('should produce same order-of-magnitude event count for both CEO types', () => {
      // Agent CEO
      const agentEmitted: TaskEvent[] = [];
      const agentBuffer = new StreamEventBuffer((evt) => agentEmitted.push(evt));
      for (const evt of simulateAgentCEOStream()) agentBuffer.push(evt);
      agentBuffer.flush();

      // Claude Code CEO
      const ccEmitted: TaskEvent[] = [];
      const ccBuffer = new StreamEventBuffer((evt) => ccEmitted.push(evt));
      for (const evt of simulateClaudeCodeCEOStream()) ccBuffer.push(evt);
      ccBuffer.flush();

      // Both should be in a similar range (within 3x of each other)
      const ratio = Math.max(agentEmitted.length, ccEmitted.length) / Math.min(agentEmitted.length, ccEmitted.length);
      assert.ok(ratio <= 3, `Event counts too different: agent=${agentEmitted.length} cc=${ccEmitted.length} ratio=${ratio.toFixed(1)}`);
    });

    it('should produce same event type distribution for both CEO types', () => {
      // Agent CEO
      const agentEmitted: TaskEvent[] = [];
      const agentBuffer = new StreamEventBuffer((evt) => agentEmitted.push(evt));
      for (const evt of simulateAgentCEOStream()) agentBuffer.push(evt);
      agentBuffer.flush();

      // Claude Code CEO
      const ccEmitted: TaskEvent[] = [];
      const ccBuffer = new StreamEventBuffer((evt) => ccEmitted.push(evt));
      for (const evt of simulateClaudeCodeCEOStream()) ccBuffer.push(evt);
      ccBuffer.flush();

      // Both should have thinking, tool_start, tool_end, content events
      const agentTypes = new Set(agentEmitted.map(e => e.type));
      const ccTypes = new Set(ccEmitted.map(e => e.type));

      assert.ok(agentTypes.has('thinking'), 'Agent CEO should have thinking events');
      assert.ok(agentTypes.has('tool_start'), 'Agent CEO should have tool_start events');
      assert.ok(agentTypes.has('tool_end'), 'Agent CEO should have tool_end events');
      assert.ok(agentTypes.has('content'), 'Agent CEO should have content events');

      assert.ok(ccTypes.has('thinking'), 'Claude Code CEO should have thinking events');
      assert.ok(ccTypes.has('tool_start'), 'Claude Code CEO should have tool_start events');
      assert.ok(ccTypes.has('tool_end'), 'Claude Code CEO should have tool_end events');
      assert.ok(ccTypes.has('content'), 'Claude Code CEO should have content events');
    });
  });

  // ── Model-specific patterns ──

  describe('no-thinking model (GPT-4o, Gemini style)', () => {
    it('should handle streams without any thinking tokens', () => {
      const rawEvents = simulateNoThinkingModelStream();
      for (const evt of rawEvents) buffer.push(evt);
      buffer.flush();

      const thinkingEvents = emitted.filter(e => e.type === 'thinking');
      assert.equal(thinkingEvents.length, 0, 'Should have no thinking events');

      const contentEvents = emitted.filter(e => e.type === 'content');
      assert.ok(contentEvents.length >= 1, 'Should have content events');
      assert.ok(contentEvents.length <= 3, 'Content tokens should be buffered into few events');

      const toolEvents = emitted.filter(e => e.type === 'tool_start' || e.type === 'tool_end');
      assert.equal(toolEvents.length, 2, 'Should have tool_start + tool_end');
    });
  });

  describe('heavy-thinking model (extended thinking)', () => {
    it('should compress 500+ thinking tokens into a single event', () => {
      const rawEvents = simulateHeavyThinkingModelStream();
      assert.ok(rawEvents.length > 500, `Expected >500 raw events, got ${rawEvents.length}`);

      for (const evt of rawEvents) buffer.push(evt);
      buffer.flush();

      const thinkingEvents = emitted.filter(e => e.type === 'thinking');
      assert.equal(thinkingEvents.length, 1, 'All thinking should merge into one event');
      assert.ok(thinkingEvents[0].content!.length > 1000, 'Thinking text should be complete');

      const contentEvents = emitted.filter(e => e.type === 'content');
      assert.equal(contentEvents.length, 1);
      assert.equal(contentEvents[0].content, 'Done.');
    });
  });

  describe('rapid type alternation', () => {
    it('should handle rapid switching between thinking and content', () => {
      const rawEvents = simulateRapidTypeAlternation();
      assert.equal(rawEvents.length, 40); // 20 thinking + 20 content

      for (const evt of rawEvents) buffer.push(evt);
      buffer.flush();

      // Each type change triggers a flush, so we get one event per token
      // because they alternate every single token
      assert.equal(emitted.length, 40, 'Rapid alternation prevents buffering');

      // But each event should still have the right type
      for (let i = 0; i < 40; i++) {
        assert.equal(emitted[i].type, i % 2 === 0 ? 'thinking' : 'content');
      }
    });

    it('should still merge consecutive same-type tokens even in mixed streams', () => {
      // Pattern: think, think, content, content, think, think
      buffer.push({ type: 'thinking', content: 'a' });
      buffer.push({ type: 'thinking', content: 'b' });
      buffer.push({ type: 'content', content: 'c' });
      buffer.push({ type: 'content', content: 'd' });
      buffer.push({ type: 'thinking', content: 'e' });
      buffer.push({ type: 'thinking', content: 'f' });
      buffer.flush();

      assert.equal(emitted.length, 3);
      assert.equal(emitted[0].type, 'thinking');
      assert.equal(emitted[0].content, 'ab');
      assert.equal(emitted[1].type, 'content');
      assert.equal(emitted[1].content, 'cd');
      assert.equal(emitted[2].type, 'thinking');
      assert.equal(emitted[2].content, 'ef');
    });
  });

  describe('consecutive tool calls', () => {
    it('should handle multiple tools back-to-back without content between them', () => {
      const rawEvents = simulateConsecutiveToolCalls();
      for (const evt of rawEvents) buffer.push(evt);
      buffer.flush();

      // thinking + 3*(tool_start + tool_end) + content = 8
      assert.equal(emitted.length, 8);
      assert.equal(emitted[0].type, 'thinking');
      assert.equal(emitted[1].type, 'tool_start');
      assert.equal(emitted[1].tool, 'list_agents');
      assert.equal(emitted[2].type, 'tool_end');
      assert.equal(emitted[3].type, 'tool_start');
      assert.equal(emitted[3].tool, 'list_tickets');
      assert.equal(emitted[4].type, 'tool_end');
      assert.equal(emitted[5].type, 'tool_start');
      assert.equal(emitted[5].tool, 'create_ticket');
      assert.equal(emitted[6].type, 'tool_end');
      assert.equal(emitted[7].type, 'content');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('should handle completely empty stream', () => {
      buffer.flush();
      assert.equal(emitted.length, 0);
    });

    it('should handle stream with only tool events', () => {
      buffer.push({ type: 'tool_start', tool: 'a' });
      buffer.push({ type: 'tool_end', tool: 'a', output: 'x' });
      buffer.flush();
      assert.equal(emitted.length, 2);
    });

    it('should handle stream with only thinking tokens', () => {
      for (let i = 0; i < 100; i++) {
        buffer.push({ type: 'thinking', content: `t${i} ` });
      }
      buffer.flush();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, 'thinking');
    });

    it('should handle stream with only content tokens', () => {
      for (let i = 0; i < 100; i++) {
        buffer.push({ type: 'content', content: `w${i} ` });
      }
      buffer.flush();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, 'content');
    });

    it('should handle stream ending with tool_end (no trailing content)', () => {
      buffer.push({ type: 'content', content: 'before' });
      buffer.push({ type: 'tool_start', tool: 'x' });
      buffer.push({ type: 'tool_end', tool: 'x', output: 'done' });
      buffer.flush();
      assert.equal(emitted.length, 3);
      assert.equal(emitted[2].type, 'tool_end');
    });

    it('should handle single-character tokens', () => {
      const text = 'Hello, world!';
      for (const ch of text) {
        buffer.push({ type: 'content', content: ch });
      }
      buffer.flush();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].content, text);
    });

    it('should trim whitespace from accumulated text', () => {
      buffer.push({ type: 'content', content: '  hello  ' });
      buffer.push({ type: 'content', content: '  world  ' });
      buffer.flush();
      assert.equal(emitted[0].content, 'hello    world');
    });

    it('should handle newlines in content correctly', () => {
      buffer.push({ type: 'content', content: 'line1\n' });
      buffer.push({ type: 'content', content: 'line2\n' });
      buffer.push({ type: 'content', content: 'line3' });
      buffer.flush();
      assert.equal(emitted[0].content, 'line1\nline2\nline3');
    });

    it('should handle unicode content', () => {
      buffer.push({ type: 'content', content: 'Hello ' });
      buffer.push({ type: 'content', content: '世界 ' });
      buffer.push({ type: 'content', content: '🌍' });
      buffer.flush();
      assert.equal(emitted[0].content, 'Hello 世界 🌍');
    });

    it('should handle tool_start with undefined input/output', () => {
      buffer.push({ type: 'tool_start', tool: 'noop' });
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].input, undefined);
    });

    it('should handle thinking dedup across tool boundaries', () => {
      buffer.push({ type: 'thinking', content: 'same' });
      buffer.push({ type: 'tool_start', tool: 'x' });
      buffer.push({ type: 'tool_end', tool: 'x', output: 'y' });
      // Same thinking content after tool call
      buffer.push({ type: 'thinking', content: 'same' });
      buffer.flush();

      const thinkingEvents = emitted.filter(e => e.type === 'thinking');
      // Should be deduplicated even though there was a tool call between them
      assert.equal(thinkingEvents.length, 1);
    });

    it('should handle content dedup NOT happening (only thinking is deduped)', () => {
      buffer.push({ type: 'content', content: 'same text' });
      buffer.flush();
      buffer.push({ type: 'content', content: 'same text' });
      buffer.flush();

      const contentEvents = emitted.filter(e => e.type === 'content');
      // Content should NOT be deduplicated (only thinking is)
      assert.equal(contentEvents.length, 2);
    });
  });

  // ── Stress tests ──

  describe('stress tests', () => {
    it('should handle 10,000 content tokens without error', () => {
      for (let i = 0; i < 10000; i++) {
        buffer.push({ type: 'content', content: `word${i} ` });
      }
      buffer.flush();
      assert.equal(emitted.length, 1);
      assert.ok(emitted[0].content!.length > 50000);
    });

    it('should handle interleaved stream of 1000 events efficiently', () => {
      // Realistic: thinking → tool → content → tool → content, repeated
      for (let i = 0; i < 100; i++) {
        // 3 thinking tokens
        buffer.push({ type: 'thinking', content: `think${i}a ` });
        buffer.push({ type: 'thinking', content: `think${i}b ` });
        buffer.push({ type: 'thinking', content: `think${i}c ` });
        // tool call
        buffer.push({ type: 'tool_start', tool: `tool_${i}`, input: { i } });
        buffer.push({ type: 'tool_end', tool: `tool_${i}`, output: `result_${i}` });
        // 5 content tokens
        for (let j = 0; j < 5; j++) {
          buffer.push({ type: 'content', content: `c${i}_${j} ` });
        }
      }
      buffer.flush();

      // 100 iterations × (1 thinking + 1 tool_start + 1 tool_end + 1 content) = 400
      // But consecutive thinking and content blocks merge across iterations
      // Actually: each iteration ends with content, next starts with thinking → type change → flush
      // So: 100 thinking + 100 tool_start + 100 tool_end + 100 content = 400
      assert.equal(emitted.length, 400);

      const types = { thinking: 0, tool_start: 0, tool_end: 0, content: 0 };
      for (const evt of emitted) {
        types[evt.type as keyof typeof types]++;
      }
      assert.equal(types.thinking, 100);
      assert.equal(types.tool_start, 100);
      assert.equal(types.tool_end, 100);
      assert.equal(types.content, 100);
    });
  });
});

describe('summarizeOutput', () => {
  it('should return short strings unchanged', () => {
    assert.equal(summarizeOutput('short'), 'short');
  });

  it('should truncate strings longer than 500 chars', () => {
    const long = 'x'.repeat(600);
    const result = summarizeOutput(long) as string;
    assert.equal(result.length, 503);
    assert.ok(result.endsWith('...'));
  });

  it('should handle exactly 500 char string without truncation', () => {
    const exact = 'x'.repeat(500);
    assert.equal(summarizeOutput(exact), exact);
  });

  it('should handle 501 char string with truncation', () => {
    const overBy1 = 'x'.repeat(501);
    const result = summarizeOutput(overBy1) as string;
    assert.equal(result.length, 503);
  });

  it('should strip base64 image data from arrays', () => {
    const output = [
      { type: 'image', mediaType: 'image/png', data: 'a'.repeat(10000) },
      { type: 'text', text: 'hello' },
    ];
    const result = summarizeOutput(output) as any[];
    assert.equal(result[0].type, 'image');
    assert.equal(result[0].bytes, 10000);
    assert.equal(result[0].data, undefined);
    assert.deepEqual(result[1], { type: 'text', text: 'hello' });
  });

  it('should handle image with no data field', () => {
    const output = [{ type: 'image', mediaType: 'image/png' }];
    const result = summarizeOutput(output) as any[];
    assert.equal(result[0].bytes, 0);
  });

  it('should pass through non-string non-array values', () => {
    assert.equal(summarizeOutput(42), 42);
    assert.equal(summarizeOutput(null), null);
    assert.deepEqual(summarizeOutput({ key: 'val' }), { key: 'val' });
  });

  it('should pass through undefined', () => {
    assert.equal(summarizeOutput(undefined), undefined);
  });

  it('should handle empty string', () => {
    assert.equal(summarizeOutput(''), '');
  });

  it('should handle empty array', () => {
    assert.deepEqual(summarizeOutput([]), []);
  });

  it('should handle array with unknown part types', () => {
    const output = [{ type: 'audio', data: 'xxx' }];
    const result = summarizeOutput(output) as any[];
    assert.deepEqual(result[0], { type: 'audio', data: 'xxx' });
  });
});
