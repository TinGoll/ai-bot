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
    const reply = await this.botService.handleTelegramText(text.trim());

    if (!reply) {
      return;
    }

    await ctx.reply(reply);
  }
}
