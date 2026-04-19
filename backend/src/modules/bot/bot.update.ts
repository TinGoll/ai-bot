import { Injectable } from '@nestjs/common';
import { Ctx, Message, On, Update } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { BotService } from './bot.service';
import { UsersService } from '../users/users.service';
import { USER_ROLE_VALUES, UserRole } from '../users/entities/user-role.enum';

const MENU_BUTTONS = {
  profile: 'Профиль',
  roles: 'Мои роли',
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
      [MENU_BUTTONS.profile, MENU_BUTTONS.roles],
      [MENU_BUTTONS.changeDisplayName],
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
      `роли: ${profile.roles.join(', ')}`,
      `дата регистрации: ${profile.createdAt.toLocaleString('ru-RU')}`,
    ].join('\n');

    await ctx.reply(profileText, this.getMainMenuKeyboard());
  }

  private async showRoleDescriptions(
    ctx: Context,
    telegramId: number,
  ): Promise<void> {
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

    const lines = ['Ваши роли:'];
    for (const roleDescription of profile.roleDescriptions) {
      lines.push(`• ${roleDescription.role}: ${roleDescription.description}`);
    }

    await ctx.reply(lines.join('\n'), this.getMainMenuKeyboard());
  }

  private parseRole(role: string): UserRole | null {
    const normalizedRole = role.trim() as UserRole;
    if (!USER_ROLE_VALUES.includes(normalizedRole)) {
      return null;
    }

    return normalizedRole;
  }

  private async handleAdminCommand(
    ctx: Context,
    actorTelegramId: number,
    text: string,
  ): Promise<boolean> {
    const [command, ...args] = text.split(' ');

    if (command === '/admin_help') {
      await ctx.reply(
        [
          'Команды администратора:',
          '/admin_set_role <telegramId> <role> <on|off>',
          '/admin_block <telegramId> <permanent|minutes> [reason]',
          '/admin_unblock <telegramId>',
          '/admin_role_desc <role> <description>',
        ].join('\n'),
      );
      return true;
    }

    if (command === '/admin_set_role') {
      const [targetTelegramId, roleRaw, modeRaw] = args;
      const role = roleRaw ? this.parseRole(roleRaw) : null;
      const enabled = modeRaw === 'on';
      const disabled = modeRaw === 'off';
      if (!targetTelegramId || !role || (!enabled && !disabled)) {
        await ctx.reply('Формат: /admin_set_role <telegramId> <role> <on|off>');
        return true;
      }

      try {
        const user = await this.usersService.setUserRoleByAdmin({
          actorTelegramId: String(actorTelegramId),
          targetTelegramId,
          role,
          enabled,
        });
        await ctx.reply(
          `Роли пользователя ${user.id}: ${user.roles.join(', ')}`,
        );
      } catch {
        await ctx.reply(
          'Не удалось изменить роль. Проверьте права и параметры.',
        );
      }
      return true;
    }

    if (command === '/admin_block') {
      const [targetTelegramId, modeRaw, ...reasonParts] = args;
      if (!targetTelegramId || !modeRaw) {
        await ctx.reply(
          'Формат: /admin_block <telegramId> <permanent|minutes> [reason]',
        );
        return true;
      }

      const mode: 'temporary' | 'permanent' =
        modeRaw === 'permanent' ? 'permanent' : 'temporary';
      const durationMinutes =
        mode === 'temporary' ? Number.parseInt(modeRaw, 10) : undefined;
      if (mode === 'temporary' && (!durationMinutes || durationMinutes <= 0)) {
        await ctx.reply(
          'Для временной блокировки укажите число минут больше 0.',
        );
        return true;
      }

      try {
        const user = await this.usersService.blockUserByAdmin({
          actorTelegramId: String(actorTelegramId),
          targetTelegramId,
          mode,
          durationMinutes,
          reason: reasonParts.join(' ').trim() || undefined,
        });
        const suffix =
          user.blockedUntil && mode === 'temporary'
            ? ` до ${user.blockedUntil.toLocaleString('ru-RU')}`
            : '';
        await ctx.reply(`Пользователь ${user.id} заблокирован${suffix}.`);
      } catch {
        await ctx.reply(
          'Не удалось выполнить блокировку. Проверьте права и параметры.',
        );
      }
      return true;
    }

    if (command === '/admin_unblock') {
      const [targetTelegramId] = args;
      if (!targetTelegramId) {
        await ctx.reply('Формат: /admin_unblock <telegramId>');
        return true;
      }

      try {
        const user = await this.usersService.blockUserByAdmin({
          actorTelegramId: String(actorTelegramId),
          targetTelegramId,
          mode: 'unblock',
        });
        await ctx.reply(`Пользователь ${user.id} разблокирован.`);
      } catch {
        await ctx.reply(
          'Не удалось снять блокировку. Проверьте права и параметры.',
        );
      }
      return true;
    }

    if (command === '/admin_role_desc') {
      const [roleRaw, ...descriptionParts] = args;
      const role = roleRaw ? this.parseRole(roleRaw) : null;
      const description = descriptionParts.join(' ').trim();

      if (!role || !description) {
        await ctx.reply('Формат: /admin_role_desc <role> <description>');
        return true;
      }

      try {
        const roleDescription =
          await this.usersService.updateRoleDescriptionByAdmin({
            actorTelegramId: String(actorTelegramId),
            role,
            description,
          });
        await ctx.reply(
          `Описание роли ${roleDescription.role} обновлено: ${roleDescription.description}`,
        );
      } catch {
        await ctx.reply(
          'Не удалось обновить описание роли. Проверьте права и параметры.',
        );
      }
      return true;
    }

    return false;
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

    const adminCommandHandled = await this.handleAdminCommand(
      ctx,
      telegramId,
      trimmedText,
    );
    if (adminCommandHandled) {
      return;
    }

    const blockStatus = await this.usersService.getBlockStatusByTelegramId(
      String(telegramId),
    );
    if (blockStatus?.isBlocked) {
      const blockedUntilText = blockStatus.blockedUntil
        ? ` до ${blockStatus.blockedUntil.toLocaleString('ru-RU')}`
        : ' бессрочно';
      const reasonText = blockStatus.blockReason
        ? `\nПричина: ${blockStatus.blockReason}`
        : '';
      await ctx.reply(`Ваш доступ ограничен${blockedUntilText}.${reasonText}`);
      return;
    }

    if (trimmedText === MENU_BUTTONS.profile) {
      await this.showProfile(ctx, telegramId);
      return;
    }

    if (trimmedText === MENU_BUTTONS.roles) {
      await this.showRoleDescriptions(ctx, telegramId);
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
