import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DevicesService } from '../devices/devices.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fallbackModel = 'openrouter/free';
  private readonly systemPrompt: string;
  private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'getDevices',
        description: 'Return all smart-home devices and their current states.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'toggleLight',
        description:
          'Toggle a light device by id and return the updated state.',
        parameters: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description:
                'Target device id. Example: lamp-kitchen or ac-bedroom.',
            },
          },
          required: ['deviceId'],
          additionalProperties: false,
        },
      },
    },
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly devicesService: DevicesService,
  ) {
    this.apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    this.model =
      this.configService.get<string>('OPENROUTER_MODEL') ?? this.fallbackModel;
    this.systemPrompt =
      this.configService.get<string>('OPENROUTER_SYSTEM_PROMPT') ??
      [
        'You are a smart-home assistant for Telegram.',
        'Answer briefly in Russian unless user asks another language.',
        'If the user asks about device status or control, prefer using tools.',
        'Never invent device IDs or states if tools are available.',
      ].join(' ');

    this.client = new OpenAI({
      apiKey: this.apiKey ?? 'missing-api-key',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  private buildRequest(
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    return messages;
  }

  private handleToolCall(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall,
  ): string {
    const toolName = toolCall.function.name;

    if (toolName === 'getDevices') {
      return JSON.stringify({ devices: this.devicesService.getAll() });
    }

    if (toolName === 'toggleLight') {
      let args: { deviceId?: string } = {};

      try {
        args = JSON.parse(toolCall.function.arguments) as { deviceId?: string };
      } catch {
        return JSON.stringify({ error: 'Invalid JSON arguments.' });
      }

      if (!args.deviceId) {
        return JSON.stringify({ error: 'deviceId is required.' });
      }

      const updatedDevice = this.devicesService.toggleLight(args.deviceId);

      if (!updatedDevice) {
        return JSON.stringify({ error: `Device ${args.deviceId} not found.` });
      }

      return JSON.stringify({ device: updatedDevice });
    }

    return JSON.stringify({ error: `Unknown tool ${toolName}.` });
  }

  async generateReply(
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<string> {
    if (!this.apiKey) {
      return 'OPENROUTER_API_KEY is not configured.';
    }

    const messages = this.buildRequest(userMessage, history);

    try {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      let activeModel = this.model;

      const executeCompletion = (
        includeTools: boolean,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
        return this.client.chat.completions.create({
          model: activeModel,
          messages,
          ...(includeTools ? { tools: this.tools, tool_choice: 'auto' } : {}),
        });
      };

      const isModelNotFoundError = (error: unknown): boolean => {
        return (
          error instanceof OpenAI.APIError &&
          error.status === 404 &&
          error.message.includes('No endpoints found')
        );
      };

      try {
        completion = await executeCompletion(true);
      } catch (error) {
        if (activeModel !== this.fallbackModel && isModelNotFoundError(error)) {
          this.logger.warn(
            `Model ${activeModel} not available, switching to ${this.fallbackModel}`,
          );
          activeModel = this.fallbackModel;
        }

        this.logger.warn(
          `Tool-enabled completion failed, retrying without tools: ${this.formatOpenRouterError(error)}`,
        );

        completion = await executeCompletion(false);
      }

      const firstMessage = completion.choices[0]?.message;

      if (!firstMessage) {
        return 'Empty response from OpenRouter model.';
      }

      const toolCalls = firstMessage.tool_calls ?? [];

      if (!toolCalls.length) {
        const generatedReply = firstMessage.content?.trim();

        return generatedReply || 'Empty response from OpenRouter model.';
      }

      messages.push({
        role: 'assistant',
        content: firstMessage.content ?? '',
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') {
          continue;
        }

        const toolResult = this.handleToolCall(toolCall);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      const completionWithTools = await this.client.chat.completions.create({
        model: activeModel,
        messages,
      });

      const generatedReply =
        completionWithTools.choices[0]?.message?.content?.trim();

      return generatedReply || 'Empty response from OpenRouter model.';
    } catch (error) {
      const errorMessage = this.formatOpenRouterError(error);
      this.logger.error(`OpenRouter request failed: ${errorMessage}`);

      return `Failed to get response from OpenRouter: ${errorMessage}`;
    }
  }

  private formatOpenRouterError(error: unknown): string {
    if (error instanceof OpenAI.APIError) {
      const code = error.code ? ` (${error.code})` : '';
      return `${error.status}: ${error.message}${code}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}
