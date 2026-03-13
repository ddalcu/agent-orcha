import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  contentToText,
  humanMessage,
  aiMessage,
  systemMessage,
  toolMessage,
  stripOldImages,
  NodeInterrupt,
} from '../../lib/types/llm-types.ts';
import type { BaseMessage, ContentPart } from '../../lib/types/llm-types.ts';

describe('contentToText', () => {
  it('should return a string as-is', () => {
    assert.equal(contentToText('hello'), 'hello');
  });

  it('should join text parts from ContentPart array', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ];
    assert.equal(contentToText(parts), 'hello world');
  });

  it('should ignore image parts', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'base64data', mediaType: 'image/png' },
    ];
    assert.equal(contentToText(parts), 'caption');
  });

  it('should return empty string for array with only images', () => {
    const parts: ContentPart[] = [
      { type: 'image', data: 'data1', mediaType: 'image/jpeg' },
    ];
    assert.equal(contentToText(parts), '');
  });
});

describe('message factories', () => {
  it('humanMessage creates a human role message', () => {
    const msg = humanMessage('hi');
    assert.deepStrictEqual(msg, { role: 'human', content: 'hi' });
  });

  it('humanMessage accepts ContentPart array', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'hello' }];
    const msg = humanMessage(parts);
    assert.equal(msg.role, 'human');
    assert.deepStrictEqual(msg.content, parts);
  });

  it('aiMessage creates an ai role message without tool_calls', () => {
    const msg = aiMessage('response');
    assert.deepStrictEqual(msg, { role: 'ai', content: 'response' });
    assert.equal(msg.tool_calls, undefined);
  });

  it('aiMessage creates an ai role message with tool_calls', () => {
    const calls = [{ id: '1', name: 'test', args: { a: 1 } }];
    const msg = aiMessage('response', calls);
    assert.equal(msg.role, 'ai');
    assert.deepStrictEqual(msg.tool_calls, calls);
  });

  it('aiMessage omits tool_calls when array is empty', () => {
    const msg = aiMessage('response', []);
    assert.equal(msg.tool_calls, undefined);
  });

  it('systemMessage creates a system role message', () => {
    const msg = systemMessage('you are helpful');
    assert.deepStrictEqual(msg, { role: 'system', content: 'you are helpful' });
  });

  it('toolMessage creates a tool role message', () => {
    const msg = toolMessage('result', 'call-123', 'my_tool');
    assert.deepStrictEqual(msg, {
      role: 'tool',
      content: 'result',
      tool_call_id: 'call-123',
      name: 'my_tool',
    });
  });

  it('toolMessage accepts ContentPart array content', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'output' }];
    const msg = toolMessage(parts, 'call-456', 'other_tool');
    assert.equal(msg.role, 'tool');
    assert.deepStrictEqual(msg.content, parts);
  });
});

describe('stripOldImages', () => {
  it('should return messages unchanged when no images exist', () => {
    const msgs: BaseMessage[] = [
      { role: 'human', content: 'hi' },
      { role: 'ai', content: 'hello' },
    ];
    const result = stripOldImages(msgs);
    assert.strictEqual(result, msgs);
  });

  it('should return messages unchanged when only the last message has images', () => {
    const msgs: BaseMessage[] = [
      { role: 'human', content: 'describe this' },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'img1', mediaType: 'image/png' },
          { type: 'text', text: 'screenshot taken' },
        ],
        tool_call_id: 'tc1',
        name: 'screenshot',
      },
    ];
    const result = stripOldImages(msgs);
    assert.strictEqual(result, msgs);
  });

  it('should strip images from older messages, keeping text', () => {
    const msgs: BaseMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'old-img', mediaType: 'image/jpeg' },
          { type: 'text', text: 'old caption' },
        ],
        tool_call_id: 'tc1',
        name: 'screenshot',
      },
      { role: 'ai', content: 'I see the old image' },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'new-img', mediaType: 'image/png' },
          { type: 'text', text: 'new caption' },
        ],
        tool_call_id: 'tc2',
        name: 'screenshot',
      },
    ];

    const result = stripOldImages(msgs);

    // The last image message should be untouched
    assert.strictEqual(result[2], msgs[2]);

    // The middle text-only message should be untouched
    assert.strictEqual(result[1], msgs[1]);

    // The first message should have images replaced with omission notice
    const firstContent = result[0]!.content as ContentPart[];
    assert.equal(firstContent.length, 1);
    assert.equal(firstContent[0]!.type, 'text');
    assert.ok((firstContent[0] as { type: 'text'; text: string }).text.includes('1 image(s) omitted'));
    assert.ok((firstContent[0] as { type: 'text'; text: string }).text.includes('old caption'));
  });

  it('should handle messages with only image parts (no text)', () => {
    const msgs: BaseMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'img1', mediaType: 'image/png' },
          { type: 'image', data: 'img2', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc1',
        name: 'tool1',
      },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'img3', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc2',
        name: 'tool2',
      },
    ];

    const result = stripOldImages(msgs);
    const firstContent = result[0]!.content as ContentPart[];
    assert.equal(firstContent.length, 1);
    assert.ok((firstContent[0] as { type: 'text'; text: string }).text.includes('2 image(s) omitted'));
  });

  it('should not modify string content messages', () => {
    const msgs: BaseMessage[] = [
      { role: 'human', content: 'plain text' },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'img', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc1',
        name: 'tool1',
      },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'img2', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc2',
        name: 'tool2',
      },
    ];

    const result = stripOldImages(msgs);
    // String content message is passed through unchanged
    assert.strictEqual(result[0], msgs[0]);
    // Middle image message gets stripped
    const middleContent = result[1]!.content as ContentPart[];
    assert.ok((middleContent[0] as { type: 'text'; text: string }).text.includes('omitted'));
    // Last image message is preserved
    assert.strictEqual(result[2], msgs[2]);
  });

  it('should not strip array content messages without images', () => {
    const msgs: BaseMessage[] = [
      {
        role: 'human',
        content: [{ type: 'text', text: 'just text parts' }],
      },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'old', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc1',
        name: 'tool1',
      },
      {
        role: 'tool',
        content: [
          { type: 'image', data: 'new', mediaType: 'image/png' },
        ],
        tool_call_id: 'tc2',
        name: 'tool2',
      },
    ];

    const result = stripOldImages(msgs);
    // Text-only array content should be left untouched
    assert.strictEqual(result[0], msgs[0]);
  });
});

describe('NodeInterrupt', () => {
  it('should create an error with the question as message', () => {
    const interrupt = new NodeInterrupt({ question: 'What is your name?' });
    assert.equal(interrupt.message, 'What is your name?');
    assert.equal(interrupt.name, 'NodeInterrupt');
    assert.deepStrictEqual(interrupt.data, { question: 'What is your name?' });
  });

  it('should use default message when no question provided', () => {
    const interrupt = new NodeInterrupt({ foo: 'bar' });
    assert.equal(interrupt.message, 'Workflow interrupted');
    assert.equal(interrupt.name, 'NodeInterrupt');
    assert.deepStrictEqual(interrupt.data, { foo: 'bar' });
  });

  it('should be an instance of Error', () => {
    const interrupt = new NodeInterrupt({ question: 'test' });
    assert.ok(interrupt instanceof Error);
    assert.ok(interrupt instanceof NodeInterrupt);
  });
});
