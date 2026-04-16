import { Injectable } from '@nestjs/common';
import { TelegramUpdate } from '../../common/types';
import { AiService } from '../ai/ai.service';

type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class BotService {
  private readonly maxHistoryMessages = 10;
  private readonly historyByConversation = new Map<
    string,
    ChatHistoryMessage[]
  >();

  constructor(private readonly aiService: AiService) {}

  async handleTelegramUpdate(update: TelegramUpdate): Promise<string | null> {
    const messageText = update.message?.text?.trim();
    const chatId = update.message?.chat?.id;
    const conversationId =
      typeof chatId === 'number' ? `telegram:${chatId}` : 'telegram:unknown';

    return this.handleTelegramText(messageText, conversationId);
  }

  async handleTelegramText(
    text?: string,
    conversationId = 'telegram:unknown',
  ): Promise<string | null> {
    if (!text) {
      return null;
    }

    const history = this.historyByConversation.get(conversationId) ?? [];
    const reply = await this.aiService.generateReply(text, history);

    const updatedHistory: ChatHistoryMessage[] = [...history];
    updatedHistory.push({ role: 'user', content: text });
    updatedHistory.push({ role: 'assistant', content: reply });

    const trimmedHistory = updatedHistory.slice(-this.maxHistoryMessages);

    this.historyByConversation.set(conversationId, trimmedHistory);

    return reply;
  }
}
