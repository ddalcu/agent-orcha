import { GoogleGenerativeAI, type Content, type Part, type FunctionDeclarationSchema, type FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  contentToText,
  type ChatModel,
  type ChatModelResponse,
  type BaseMessage,
  type StructuredTool,
  type ToolCall,
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
        const text = contentToText(msg.content);
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${text}`
          : text;
        continue;
      }

      if (msg.role === 'human') {
        if (Array.isArray(msg.content)) {
          const parts: Part[] = msg.content.map(p => {
            if (p.type === 'image') {
              return { inlineData: { mimeType: p.mediaType, data: p.data } };
            }
            return { text: p.text };
          });
          contents.push({ role: 'user', parts });
        } else {
          contents.push({ role: 'user', parts: [{ text: msg.content }] });
        }
      } else if (msg.role === 'ai') {
        const parts: Part[] = [];
        const text = contentToText(msg.content);
        if (text) {
          parts.push({ text });
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
        if (Array.isArray(msg.content)) {
          const parts: Part[] = [];
          // Add function response with text content
          const textContent = contentToText(msg.content);
          parts.push({
            functionResponse: {
              name: msg.name!,
              response: { result: textContent },
            },
          });
          // Add inline image data for image parts
          for (const p of msg.content) {
            if (p.type === 'image') {
              parts.push({
                inlineData: { mimeType: p.mediaType, data: p.data },
              });
            }
          }
          contents.push({ role: 'function', parts });
        } else {
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
        geminiProps[key] = this.convertPropertyToGemini(prop);
      }
      result.properties = geminiProps;
    }

    if (required) {
      result.required = required;
    }

    return result;
  }

  private convertPropertyToGemini(prop: Record<string, unknown>): Record<string, unknown> {
    const type = prop.type as string;
    const result: Record<string, unknown> = {
      type: this.mapSchemaType(type),
    };

    if (prop.description) {
      result.description = prop.description;
    }

    if (type === 'array') {
      const items = prop.items as Record<string, unknown> | undefined;
      result.items = items
        ? this.convertPropertyToGemini(items)
        : { type: SchemaType.STRING };
    }

    if (type === 'object' && prop.properties) {
      const nested = prop.properties as Record<string, Record<string, unknown>>;
      const geminiProps: Record<string, unknown> = {};
      for (const [key, nestedProp] of Object.entries(nested)) {
        geminiProps[key] = this.convertPropertyToGemini(nestedProp);
      }
      result.properties = geminiProps;
      if (prop.required) {
        result.required = prop.required;
      }
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
