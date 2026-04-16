import { Body, Controller, Post } from '@nestjs/common';
import type { TelegramUpdate } from '../../common/types';
import { BotService } from './bot.service';

@Controller('bot')
export class BotController {
  constructor(private readonly botService: BotService) {}

  @Post('telegram/webhook')
  async handleWebhook(
    @Body() update: TelegramUpdate,
  ): Promise<{ reply: string | null }> {
    const reply = await this.botService.handleTelegramUpdate(update);

    return { reply };
  }
}
