import { Injectable } from '@nestjs/common';
import { Ctx, Message, On, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { BotService } from './bot.service';

@Injectable()
@Update()
export class BotUpdate {
  constructor(private readonly botService: BotService) {}

  @On('text')
  async onText(
    @Ctx() ctx: Context,
    @Message('text') text: string,
  ): Promise<void> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    const chatId = ctx.chat?.id;
    const conversationId =
      typeof chatId === 'number' ? `telegram:${chatId}` : 'telegram:unknown';
    const placeholderMessage = await ctx.reply('Печатает...');
    const reply = await this.botService.handleTelegramText(trimmedText, conversationId);

    if (!reply) {
      await ctx.telegram.deleteMessage(
        placeholderMessage.chat.id,
        placeholderMessage.message_id,
      );
      return;
    }

    await ctx.telegram.editMessageText(
      placeholderMessage.chat.id,
      placeholderMessage.message_id,
      undefined,
      reply,
    );
  }
}
