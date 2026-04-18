import { Injectable } from '@nestjs/common';
import { TelegramUpdate } from '../../common/types';
import { AiService } from '../ai/ai.service';
import { UsersService } from '../users/users.service';

type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class BotService {
  private readonly maxHistoryMessages = 10;
  private readonly historyByConversation = new Map<
    string,
    ChatHistoryMessage[]
  >();

  constructor(
    private readonly aiService: AiService,
    private readonly usersService: UsersService,
  ) {}

  async handleTelegramUpdate(update: TelegramUpdate): Promise<string | null> {
    const messageText = update.message?.text?.trim();
    const chatId = update.message?.chat?.id;
    const telegramId = update.message?.from?.id;
    const username = update.message?.from?.username;
    const conversationId =
      typeof chatId === 'number' ? `telegram:${chatId}` : 'telegram:unknown';

    return this.handleTelegramMessage({
      text: messageText,
      conversationId,
      telegramId,
      username,
      chatId,
    });
  }

  async handleTelegramMessage(data: {
    text?: string;
    conversationId: string;
    telegramId?: number;
    username?: string;
    chatId?: number;
  }): Promise<string | null> {
    if (!data.text) {
      return null;
    }

    const text = data.text.trim();
    if (!text) {
      return null;
    }

    if (text.startsWith('/start')) {
      return this.handleStartCommand(data);
    }

    if (text.startsWith('/link')) {
      return this.handleLinkCommand(text, data);
    }

    return this.handleTelegramText(text, data.conversationId);
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

  private async handleStartCommand(data: {
    telegramId?: number;
    username?: string;
    chatId?: number;
  }): Promise<string> {
    if (!data.telegramId) {
      return 'Не удалось определить Telegram-аккаунт. Попробуйте снова позже.';
    }

    const result = await this.usersService.registerOrGetByTelegram({
      telegramId: String(data.telegramId),
      username: data.username,
      chatId: data.chatId ? String(data.chatId) : undefined,
    });

    if (result.isNewUser) {
      return `Регистрация выполнена. Ваш ID: ${result.user.id}. Используйте его в будущем дашборде.`;
    }

    return `Аккаунт уже зарегистрирован. Ваш ID: ${result.user.id}.`;
  }

  private async handleLinkCommand(
    text: string,
    data: { telegramId?: number; username?: string; chatId?: number },
  ): Promise<string> {
    if (!data.telegramId) {
      return 'Не удалось определить Telegram-аккаунт. Попробуйте снова позже.';
    }

    const parts = text.split(' ').filter(Boolean);
    const code = parts[1]?.trim();

    if (!code) {
      return 'Формат: /link 123456';
    }

    try {
      const user = await this.usersService.linkTelegramByCode({
        code,
        telegramId: String(data.telegramId),
        username: data.username,
        chatId: data.chatId ? String(data.chatId) : undefined,
      });

      return `Telegram-аккаунт связан с пользователем ${user.id}.`;
    } catch {
      return 'Не удалось выполнить привязку. Проверьте код и попробуйте снова.';
    }
  }
}
