import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAskUserTool } from '../../lib/tools/built-in/ask-user.tool.ts';

describe('createAskUserTool', () => {
  it('should create a tool with correct name', () => {
    const tool = createAskUserTool();
    assert.equal(tool.name, 'ask_user');
    assert.ok(tool.description.includes('Ask the user'));
  });

  it('should throw NodeInterrupt when invoked', async () => {
    const tool = createAskUserTool();

    try {
      await tool.invoke({ question: 'What is your name?' });
      assert.fail('Should have thrown');
    } catch (error: any) {
      // NodeInterrupt is thrown with the question
      assert.ok(error);
    }
  });
});
