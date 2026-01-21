import { ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate } from '@langchain/core/prompts';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentDefinition, AgentInstance, AgentResult } from './types.js';
import { LLMFactory } from '../llm/llm-factory.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { logger } from '../logger.js';

export class AgentExecutor {
  private toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  async createInstance(definition: AgentDefinition): Promise<AgentInstance> {
    const llm = LLMFactory.create(definition.llm);
    const tools = await this.toolRegistry.resolveTools(definition.tools);

    return {
      definition,
      invoke: async (input) => this.invoke(definition, llm, tools, input),
      stream: (input) => this.stream(definition, llm, tools, input),
    };
  }

  private async invoke(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown>
  ): Promise<AgentResult> {
    const startTime = Date.now();

    if (tools.length > 0) {
      return this.invokeWithTools(definition, llm, tools, input, startTime);
    }

    return this.invokeWithoutTools(definition, llm, input, startTime);
  }

  private async invokeWithTools(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown>,
    startTime: number
  ): Promise<AgentResult> {
    try {
      const agent = createReactAgent({
        llm,
        tools,
        stateModifier: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, input);

      logger.info(`[Agent: ${definition.name}] Invoking with ${tools.length} tools...`);
      logger.info(`[Agent: ${definition.name}] User message: ${userMessage.substring(0, 100)}...`);

      // Increase recursion limit to prevent premature termination
      // Default is 25, increase to 50 for complex workflows
      const result = await agent.invoke(
        {
          messages: [{ role: 'user', content: userMessage }],
        },
        {
          recursionLimit: 50,
        }
      );

      logger.info(`[Agent: ${definition.name}] Got ${result.messages?.length ?? 0} messages`);

      if (!result.messages || result.messages.length === 0) {
        logger.warn(`[Agent: ${definition.name}] No messages returned`);
        return {
          output: 'Agent returned no response',
          metadata: { duration: Date.now() - startTime, toolCalls: [] },
        };
      }

      const lastMessage = result.messages[result.messages.length - 1];
      let output: string;

      if (typeof lastMessage === 'object' && lastMessage !== null) {
        if ('content' in lastMessage) {
          output = String(lastMessage.content);
        } else {
          output = JSON.stringify(lastMessage);
        }
      } else {
        output = String(lastMessage);
      }

      if (!output || output === 'null' || output === 'undefined') {
        logger.warn(`[Agent: ${definition.name}] Empty output, last message:`, lastMessage);
        output = 'Agent returned empty response';
      }

      logger.info(`[Agent: ${definition.name}] Output length: ${output.length}`);

      return {
        output,
        metadata: {
          duration: Date.now() - startTime,
          toolCalls: [],
        },
      };
    } catch (error) {
      logger.error(`[Agent: ${definition.name}] Error:`, error);
      return {
        output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          duration: Date.now() - startTime,
          toolCalls: [],
        },
      };
    }
  }

  private async invokeWithoutTools(
    definition: AgentDefinition,
    llm: BaseChatModel,
    input: Record<string, unknown>,
    startTime: number
  ): Promise<AgentResult> {
    const prompt = ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(definition.prompt.system),
      HumanMessagePromptTemplate.fromTemplate('{userInput}'),
    ]);

    const userMessage = this.formatUserMessage(definition, input);
    const messages = await prompt.formatMessages({ userInput: userMessage });
    const result = await llm.invoke(messages);

    return {
      output: String(result.content),
      metadata: {
        duration: Date.now() - startTime,
      },
    };
  }

  private formatUserMessage(definition: AgentDefinition, input: Record<string, unknown>): string {
    if (definition.prompt.inputVariables.length === 0) {
      return JSON.stringify(input);
    }

    if (definition.prompt.inputVariables.length === 1) {
      const key = definition.prompt.inputVariables[0];
      const value = key ? input[key] : undefined;
      return value !== undefined ? String(value) : '';
    }

    return definition.prompt.inputVariables
      .map((variable) => {
        const value = input[variable];
        return `${variable}: ${value !== undefined ? String(value) : ''}`;
      })
      .join('\n');
  }

  private async *stream(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown>
  ): AsyncGenerator<string, void, unknown> {
    if (tools.length > 0) {
      const agent = createReactAgent({
        llm,
        tools,
        stateModifier: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, input);

      // Note: stream may not support recursionLimit config directly
      // If recursion limit is needed for streaming, consider using withConfig
      const stream = await agent.stream({
        messages: [{ role: 'user', content: userMessage }],
      });

      for await (const chunk of stream) {
        if (chunk.agent?.messages && Array.isArray(chunk.agent.messages)) {
          for (const msg of chunk.agent.messages) {
            if (typeof msg === 'object' && 'content' in msg && typeof msg.content === 'string') {
              yield msg.content;
            }
          }
        }
      }
    } else {
      const prompt = ChatPromptTemplate.fromMessages([
        SystemMessagePromptTemplate.fromTemplate(definition.prompt.system),
        HumanMessagePromptTemplate.fromTemplate('{userInput}'),
      ]);

      const userMessage = this.formatUserMessage(definition, input);
      const messages = await prompt.formatMessages({ userInput: userMessage });
      const stream = await llm.stream(messages);

      for await (const chunk of stream) {
        if (typeof chunk.content === 'string') {
          yield chunk.content;
        }
      }
    }
  }
}
