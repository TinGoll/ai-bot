import { Injectable } from '@nestjs/common';
import { TelegramUpdate } from '../../common/types';
import { AiService } from '../ai/ai.service';

@Injectable()
export class BotService {
  constructor(private readonly aiService: AiService) {}

  async handleTelegramUpdate(update: TelegramUpdate): Promise<string | null> {
    const messageText = update.message?.text?.trim();

    return this.handleTelegramText(messageText);
  }

  async handleTelegramText(text?: string): Promise<string | null> {
    if (!text) {
      return null;
    }

    return this.aiService.generateReply(text);
  }
}
