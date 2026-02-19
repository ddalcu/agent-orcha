import { GoogleGenerativeAI, type Content, type Part, type FunctionDeclarationSchema, type FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  ChatModel,
  ChatModelResponse,
  BaseMessage,
  StructuredTool,
  ToolCall,
} from '../../types/llm-types.ts';

interface GeminiChatModelOptions {
  apiKey?: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
}

export class GeminiChatModel implements ChatModel {
  private genAI: GoogleGenerativeAI;
  private modelName: string;
  private temperature?: number;
  private maxTokens?: number;
  private boundTools?: StructuredTool[];
  private structuredSchema?: Record<string, unknown>;

  constructor(options: GeminiChatModelOptions) {
    this.genAI = new GoogleGenerativeAI(options.apiKey ?? process.env.GOOGLE_API_KEY ?? '');
    this.modelName = options.modelName;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
  }

  private extractSystemAndContents(
    messages: BaseMessage[]
  ): { systemInstruction: string | undefined; contents: Content[] } {
    let systemInstruction: string | undefined;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${msg.content}`
          : msg.content;
        continue;
      }

      if (msg.role === 'human') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'ai') {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.args },
            });
          }
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: msg.name!,
                response: { result: msg.content },
              },
            },
          ],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private toGeminiTools(): { functionDeclarations: FunctionDeclaration[] }[] | undefined {
    if (!this.boundTools?.length) return undefined;
    const declarations: FunctionDeclaration[] = this.boundTools.map((t) => {
      const jsonSchema = zodToJsonSchema(t.schema) as Record<string, unknown>;
      return {
        name: t.name,
        description: t.description,
        parameters: this.convertToGeminiSchema(jsonSchema),
      };
    });
    return [{ functionDeclarations: declarations }];
  }

  private convertToGeminiSchema(jsonSchema: Record<string, unknown>): FunctionDeclarationSchema {
    const schemaType = jsonSchema.type as string;
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = jsonSchema.required as string[] | undefined;

    const result: FunctionDeclarationSchema = {
      type: this.mapSchemaType(schemaType),
      properties: {},
    };

    if (properties) {
      const geminiProps: Record<string, any> = {};
      for (const [key, prop] of Object.entries(properties)) {
        geminiProps[key] = {
          type: this.mapSchemaType(prop.type as string),
          description: prop.description as string || '',
        };
      }
      result.properties = geminiProps;
    }

    if (required) {
      result.required = required;
    }

    return result;
  }

  private mapSchemaType(type: string): SchemaType {
    switch (type) {
      case 'string': return SchemaType.STRING;
      case 'number': return SchemaType.NUMBER;
      case 'integer': return SchemaType.INTEGER;
      case 'boolean': return SchemaType.BOOLEAN;
      case 'array': return SchemaType.ARRAY;
      case 'object': return SchemaType.OBJECT;
      default: return SchemaType.STRING;
    }
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const { systemInstruction, contents } = this.extractSystemAndContents(messages);

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.maxTokens ? { maxOutputTokens: this.maxTokens } : {}),
      },
      ...(this.toGeminiTools() ? { tools: this.toGeminiTools() } : {}),
    });

    const result = await model.generateContent({ contents });
    const response = result.response;
    const candidate = response.candidates?.[0];

    let content = '';
    const toolCalls: ToolCall[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).substring(7)}`,
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    const usage = response.usageMetadata;

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage_metadata: usage
        ? {
            input_tokens: usage.promptTokenCount ?? 0,
            output_tokens: usage.candidatesTokenCount ?? 0,
            total_tokens: usage.totalTokenCount ?? 0,
          }
        : undefined,
    };
  }

  async *stream(
    messages: BaseMessage[],
    _options?: { signal?: AbortSignal }
  ): AsyncIterable<ChatModelResponse> {
    const { systemInstruction, contents } = this.extractSystemAndContents(messages);

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.maxTokens ? { maxOutputTokens: this.maxTokens } : {}),
      },
      ...(this.toGeminiTools() ? { tools: this.toGeminiTools() } : {}),
    });

    const result = await model.generateContentStream({ contents });

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      let content = '';
      const toolCalls: ToolCall[] = [];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            content += part.text;
          }
          if (part.functionCall) {
            toolCalls.push({
              id: `call_${Math.random().toString(36).substring(7)}`,
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
          }
        }
      }

      yield {
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage_metadata: chunk.usageMetadata
          ? {
              input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
              output_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined,
      };
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const bound = new GeminiChatModel({
      apiKey: '',
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
    bound.genAI = this.genAI;
    bound.boundTools = tools;
    bound.structuredSchema = this.structuredSchema;
    return bound;
  }

  withStructuredOutput(schema: Record<string, unknown>): ChatModel {
    const wrapped = new GeminiChatModel({
      apiKey: '',
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
    wrapped.genAI = this.genAI;
    wrapped.structuredSchema = schema;
    wrapped.boundTools = this.boundTools;
    return wrapped;
  }
}
