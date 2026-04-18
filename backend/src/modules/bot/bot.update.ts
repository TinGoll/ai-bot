import { Injectable } from '@nestjs/common';
import { Ctx, Message, On, Update } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { BotService } from './bot.service';
import { UsersService } from '../users/users.service';

const MENU_BUTTONS = {
  profile: 'Профиль',
  changeDisplayName: 'Изменить имя',
  back: 'Назад',
} as const;

const DISPLAY_NAME_MAX_LENGTH = 64;

type UserFlowState = 'awaiting_display_name';

@Injectable()
@Update()
export class BotUpdate {
  private readonly flowStateByTelegramId = new Map<number, UserFlowState>();

  constructor(
    private readonly botService: BotService,
    private readonly usersService: UsersService,
  ) {}

  private getMainMenuKeyboard() {
    return Markup.keyboard([
      [MENU_BUTTONS.profile, MENU_BUTTONS.changeDisplayName],
      [MENU_BUTTONS.back],
    ]).resize();
  }

  private getBackKeyboard() {
    return Markup.keyboard([[MENU_BUTTONS.back]]).resize();
  }

  private async showMainMenu(ctx: Context): Promise<void> {
    await ctx.reply('Главное меню:', this.getMainMenuKeyboard());
  }

  private async showProfile(ctx: Context, telegramId: number): Promise<void> {
    const profile = await this.usersService.getProfileByTelegramId(
      String(telegramId),
    );

    if (!profile) {
      await ctx.reply(
        'Профиль не найден. Выполните /start для регистрации.',
        this.getMainMenuKeyboard(),
      );
      return;
    }

    const profileText = [
      'Ваш профиль:',
      `username: ${profile.username ?? 'не указан'}`,
      `display_name: ${profile.displayName ?? 'не указан'}`,
      `дата регистрации: ${profile.createdAt.toLocaleString('ru-RU')}`,
    ].join('\n');

    await ctx.reply(profileText, this.getMainMenuKeyboard());
  }

  private async startDisplayNameChange(
    ctx: Context,
    telegramId: number,
  ): Promise<void> {
    this.flowStateByTelegramId.set(telegramId, 'awaiting_display_name');

    await ctx.reply(
      `Введите новое display_name (до ${DISPLAY_NAME_MAX_LENGTH} символов):`,
      this.getBackKeyboard(),
    );
  }

  private async handleDisplayNameInput(
    ctx: Context,
    telegramId: number,
    text: string,
  ): Promise<void> {
    const newDisplayName = text.trim();

    if (!newDisplayName) {
      await ctx.reply(
        'Имя не может быть пустым. Введите новое имя.',
        this.getBackKeyboard(),
      );
      return;
    }

    if (newDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
      await ctx.reply(
        `Имя слишком длинное. Максимум ${DISPLAY_NAME_MAX_LENGTH} символов.`,
        this.getBackKeyboard(),
      );
      return;
    }

    try {
      const result = await this.usersService.updateDisplayNameByTelegramId(
        String(telegramId),
        newDisplayName,
      );

      this.flowStateByTelegramId.delete(telegramId);

      const confirmationText = [
        'Имя успешно обновлено.',
        `Старое имя: ${result.previousDisplayName ?? 'не указано'}`,
        `Новое имя: ${result.updatedDisplayName}`,
      ].join('\n');

      await ctx.reply(confirmationText, this.getMainMenuKeyboard());
    } catch {
      this.flowStateByTelegramId.delete(telegramId);
      await ctx.reply(
        'Не удалось обновить имя. Выполните /start и попробуйте снова.',
        this.getMainMenuKeyboard(),
      );
    }
  }

  @On('text')
  async onText(
    @Ctx() ctx: Context,
    @Message('text') text: string,
  ): Promise<void> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    const telegramId = ctx.from?.id;

    if (trimmedText === '/menu' || trimmedText === MENU_BUTTONS.back) {
      if (typeof telegramId === 'number') {
        this.flowStateByTelegramId.delete(telegramId);
      }
      await this.showMainMenu(ctx);
      return;
    }

    if (!telegramId) {
      await ctx.reply('Не удалось определить Telegram-аккаунт.');
      return;
    }

    if (trimmedText === MENU_BUTTONS.profile) {
      await this.showProfile(ctx, telegramId);
      return;
    }

    if (trimmedText === MENU_BUTTONS.changeDisplayName) {
      await this.startDisplayNameChange(ctx, telegramId);
      return;
    }

    if (trimmedText.startsWith('/')) {
      this.flowStateByTelegramId.delete(telegramId);
    }

    const currentFlowState = this.flowStateByTelegramId.get(telegramId);
    if (currentFlowState === 'awaiting_display_name') {
      await this.handleDisplayNameInput(ctx, telegramId, trimmedText);
      return;
    }

    const chatId = ctx.chat?.id;
    const username = ctx.from?.username;
    const conversationId =
      typeof chatId === 'number' ? `telegram:${chatId}` : 'telegram:unknown';
    const placeholderMessage = await ctx.reply('Печатает...');
    const reply = await this.botService.handleTelegramMessage({
      text: trimmedText,
      conversationId,
      telegramId,
      username,
      chatId,
    });

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
