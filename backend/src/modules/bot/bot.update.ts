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
  adminUsers: 'Все пользователи',
  adminOpenProfile: 'Профиль пользователя',
  adminChangeUserRole: 'Изменить роль в профиле',
  adminChangeUserDisplayName: 'Изменить имя в профиле',
  back: 'Назад',
} as const;

const DISPLAY_NAME_MAX_LENGTH = 64;

type UserFlowState =
  | 'awaiting_display_name'
  | 'awaiting_admin_profile_target'
  | 'awaiting_admin_profile_role'
  | 'awaiting_admin_profile_display_name';

@Injectable()
@Update()
export class BotUpdate {
  private readonly flowStateByTelegramId = new Map<number, UserFlowState>();
  private readonly adminSelectedUserByTelegramId = new Map<number, string>();

  constructor(
    private readonly botService: BotService,
    private readonly usersService: UsersService,
  ) {}

  private getMainMenuKeyboard(showAdminTools = false) {
    const rows: string[][] = [
      [MENU_BUTTONS.profile, MENU_BUTTONS.roles],
      [MENU_BUTTONS.changeDisplayName],
    ];

    if (showAdminTools) {
      rows.push([MENU_BUTTONS.adminUsers, MENU_BUTTONS.adminOpenProfile]);
    }

    rows.push([MENU_BUTTONS.back]);

    return Markup.keyboard(rows).resize();
  }

  private getBackKeyboard() {
    return Markup.keyboard([[MENU_BUTTONS.back]]).resize();
  }

  private getAdminProfileKeyboard() {
    return Markup.keyboard([
      [
        MENU_BUTTONS.adminChangeUserRole,
        MENU_BUTTONS.adminChangeUserDisplayName,
      ],
      [MENU_BUTTONS.back],
    ]).resize();
  }

  private formatAdminUserProfile(profile: {
    id: string;
    telegramId: string | null;
    username: string | null;
    displayName: string | null;
    roles: UserRole[];
    isBlocked: boolean;
    blockReason: string | null;
    createdAt: Date;
  }): string {
    return [
      'Профиль пользователя:',
      `userId: ${profile.id}`,
      `telegramId: ${profile.telegramId ?? 'не привязан'}`,
      `username: ${profile.username ?? 'не указан'}`,
      `display_name: ${profile.displayName ?? 'не указан'}`,
      `роли: ${profile.roles.join(', ')}`,
      `статус: ${profile.isBlocked ? 'заблокирован' : 'активен'}`,
      `причина блокировки: ${profile.blockReason ?? 'нет'}`,
      `дата регистрации: ${profile.createdAt.toLocaleString('ru-RU')}`,
      '',
      'Управление:',
      '• Изменить роль в профиле',
      '• Изменить имя в профиле',
    ].join('\n');
  }

  private async isAdmin(telegramId: number): Promise<boolean> {
    const profile = await this.usersService.getProfileByTelegramId(
      String(telegramId),
    );

    return profile?.roles.includes(UserRole.ADMIN) ?? false;
  }

  private async showMainMenu(ctx: Context, telegramId?: number): Promise<void> {
    const showAdminTools =
      typeof telegramId === 'number' ? await this.isAdmin(telegramId) : false;

    await ctx.reply('Главное меню:', this.getMainMenuKeyboard(showAdminTools));
  }

  private async showProfile(ctx: Context, telegramId: number): Promise<void> {
    const profile = await this.usersService.getProfileByTelegramId(
      String(telegramId),
    );

    if (!profile) {
      await ctx.reply(
        'Профиль не найден. Выполните /start для регистрации.',
        this.getMainMenuKeyboard(false),
      );
      return;
    }

    const showAdminTools = await this.isAdmin(telegramId);

    const profileText = [
      'Ваш профиль:',
      `username: ${profile.username ?? 'не указан'}`,
      `display_name: ${profile.displayName ?? 'не указан'}`,
      `роли: ${profile.roles.join(', ')}`,
      `дата регистрации: ${profile.createdAt.toLocaleString('ru-RU')}`,
    ].join('\n');

    await ctx.reply(profileText, this.getMainMenuKeyboard(showAdminTools));
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
        this.getMainMenuKeyboard(false),
      );
      return;
    }

    const showAdminTools = await this.isAdmin(telegramId);

    const lines = ['Ваши роли:'];
    for (const roleDescription of profile.roleDescriptions) {
      lines.push(`• ${roleDescription.role}: ${roleDescription.description}`);
    }

    await ctx.reply(lines.join('\n'), this.getMainMenuKeyboard(showAdminTools));
  }

  private async showAdminUsers(
    ctx: Context,
    actorTelegramId: number,
  ): Promise<void> {
    try {
      const users = await this.usersService.getAllUsersByAdmin({
        actorTelegramId: String(actorTelegramId),
      });

      if (!users.length) {
        await ctx.reply(
          'Пользователи не найдены.',
          this.getMainMenuKeyboard(true),
        );
        return;
      }

      const lines = ['Пользователи:'];
      for (const user of users) {
        const username = user.username ? `@${user.username}` : 'без username';
        const displayName = user.displayName ?? 'без display_name';
        const telegramId = user.telegramId ?? 'не привязан';
        const blockedMark = user.isBlocked ? ' [blocked]' : '';
        lines.push(
          `• ${displayName}${blockedMark} | tg: ${telegramId} | userId: ${user.id} | ${username}`,
        );
      }

      await ctx.reply(lines.join('\n'), this.getMainMenuKeyboard(true));
    } catch {
      await ctx.reply(
        'Команда доступна только администратору.',
        this.getMainMenuKeyboard(false),
      );
    }
  }

  private async startAdminProfileLookup(
    ctx: Context,
    actorTelegramId: number,
  ): Promise<void> {
    const isAdmin = await this.isAdmin(actorTelegramId);
    if (!isAdmin) {
      await ctx.reply(
        'Команда доступна только администратору.',
        this.getMainMenuKeyboard(false),
      );
      return;
    }

    this.flowStateByTelegramId.set(
      actorTelegramId,
      'awaiting_admin_profile_target',
    );
    await ctx.reply(
      'Введите userId или telegramId пользователя:',
      this.getBackKeyboard(),
    );
  }

  private async handleAdminProfileLookupInput(
    ctx: Context,
    actorTelegramId: number,
    text: string,
  ): Promise<void> {
    const target = text.trim();
    if (!target) {
      await ctx.reply('Укажите userId или telegramId.', this.getBackKeyboard());
      return;
    }

    try {
      await this.openAdminUserProfile(ctx, actorTelegramId, target);
    } catch {
      this.flowStateByTelegramId.delete(actorTelegramId);
      await ctx.reply(
        'Не удалось открыть профиль. Проверьте идентификатор.',
        this.getMainMenuKeyboard(true),
      );
    }
  }

  private async openAdminUserProfile(
    ctx: Context,
    actorTelegramId: number,
    target: string,
  ): Promise<void> {
    const profile = await this.usersService.getUserProfileByAdmin({
      actorTelegramId: String(actorTelegramId),
      target,
    });

    this.flowStateByTelegramId.delete(actorTelegramId);
    this.adminSelectedUserByTelegramId.set(actorTelegramId, profile.id);

    await ctx.reply(
      this.formatAdminUserProfile(profile),
      this.getAdminProfileKeyboard(),
    );
  }

  private async startAdminUserRoleChange(
    ctx: Context,
    actorTelegramId: number,
  ): Promise<void> {
    const selectedUserId =
      this.adminSelectedUserByTelegramId.get(actorTelegramId);
    if (!selectedUserId) {
      await ctx.reply(
        'Сначала откройте профиль пользователя через кнопку «Профиль пользователя».',
        this.getMainMenuKeyboard(true),
      );
      return;
    }

    this.flowStateByTelegramId.set(
      actorTelegramId,
      'awaiting_admin_profile_role',
    );
    await ctx.reply(
      `Введите: <role> <on|off>. Доступные роли: ${USER_ROLE_VALUES.join(', ')}`,
      this.getBackKeyboard(),
    );
  }

  private async handleAdminUserRoleInput(
    ctx: Context,
    actorTelegramId: number,
    text: string,
  ): Promise<void> {
    const selectedUserId =
      this.adminSelectedUserByTelegramId.get(actorTelegramId);
    if (!selectedUserId) {
      this.flowStateByTelegramId.delete(actorTelegramId);
      await ctx.reply(
        'Сначала откройте профиль пользователя.',
        this.getMainMenuKeyboard(true),
      );
      return;
    }

    const [roleRaw, modeRaw] = text.split(' ').filter(Boolean);
    const role = roleRaw ? this.parseRole(roleRaw) : null;
    const enabled = modeRaw === 'on';
    const disabled = modeRaw === 'off';
    if (!role || (!enabled && !disabled)) {
      await ctx.reply(
        `Формат: <role> <on|off>. Доступные роли: ${USER_ROLE_VALUES.join(', ')}`,
        this.getBackKeyboard(),
      );
      return;
    }

    try {
      await this.usersService.setUserRoleByAdminByUserId({
        actorTelegramId: String(actorTelegramId),
        targetUserId: selectedUserId,
        role,
        enabled,
      });
      await this.openAdminUserProfile(ctx, actorTelegramId, selectedUserId);
    } catch {
      this.flowStateByTelegramId.delete(actorTelegramId);
      await ctx.reply(
        'Не удалось изменить роль пользователя.',
        this.getAdminProfileKeyboard(),
      );
    }
  }

  private async startAdminUserDisplayNameChange(
    ctx: Context,
    actorTelegramId: number,
  ): Promise<void> {
    const selectedUserId =
      this.adminSelectedUserByTelegramId.get(actorTelegramId);
    if (!selectedUserId) {
      await ctx.reply(
        'Сначала откройте профиль пользователя через кнопку «Профиль пользователя».',
        this.getMainMenuKeyboard(true),
      );
      return;
    }

    this.flowStateByTelegramId.set(
      actorTelegramId,
      'awaiting_admin_profile_display_name',
    );
    await ctx.reply(
      `Введите новый display_name (до ${DISPLAY_NAME_MAX_LENGTH} символов):`,
      this.getBackKeyboard(),
    );
  }

  private async handleAdminUserDisplayNameInput(
    ctx: Context,
    actorTelegramId: number,
    text: string,
  ): Promise<void> {
    const selectedUserId =
      this.adminSelectedUserByTelegramId.get(actorTelegramId);
    if (!selectedUserId) {
      this.flowStateByTelegramId.delete(actorTelegramId);
      await ctx.reply(
        'Сначала откройте профиль пользователя.',
        this.getMainMenuKeyboard(true),
      );
      return;
    }

    const newDisplayName = text.trim();
    if (!newDisplayName) {
      await ctx.reply(
        'Имя не может быть пустым. Введите display_name.',
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
      await this.usersService.updateDisplayNameByAdminByUserId({
        actorTelegramId: String(actorTelegramId),
        targetUserId: selectedUserId,
        displayName: newDisplayName,
      });
      await this.openAdminUserProfile(ctx, actorTelegramId, selectedUserId);
    } catch {
      this.flowStateByTelegramId.delete(actorTelegramId);
      await ctx.reply(
        'Не удалось обновить display_name пользователя.',
        this.getAdminProfileKeyboard(),
      );
    }
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
          '/admin_users',
          '/admin_profile <userId|telegramId>',
          '/admin_profile_role <role> <on|off>',
          '/admin_profile_name <display_name>',
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

    if (command === '/admin_users') {
      await this.showAdminUsers(ctx, actorTelegramId);
      return true;
    }

    if (command === '/admin_profile') {
      const [target] = args;
      if (!target) {
        await ctx.reply('Формат: /admin_profile <userId|telegramId>');
        return true;
      }

      try {
        await this.openAdminUserProfile(ctx, actorTelegramId, target);
      } catch {
        await ctx.reply('Не удалось открыть профиль. Проверьте идентификатор.');
      }
      return true;
    }

    if (command === '/admin_profile_role') {
      const selectedUserId =
        this.adminSelectedUserByTelegramId.get(actorTelegramId);
      const [roleRaw, modeRaw] = args;
      const role = roleRaw ? this.parseRole(roleRaw) : null;
      const enabled = modeRaw === 'on';
      const disabled = modeRaw === 'off';

      if (!selectedUserId) {
        await ctx.reply(
          'Сначала откройте профиль через /admin_profile <userId|telegramId>.',
        );
        return true;
      }

      if (!role || (!enabled && !disabled)) {
        await ctx.reply('Формат: /admin_profile_role <role> <on|off>');
        return true;
      }

      try {
        await this.usersService.setUserRoleByAdminByUserId({
          actorTelegramId: String(actorTelegramId),
          targetUserId: selectedUserId,
          role,
          enabled,
        });
        await this.openAdminUserProfile(ctx, actorTelegramId, selectedUserId);
      } catch {
        await ctx.reply('Не удалось изменить роль пользователя.');
      }
      return true;
    }

    if (command === '/admin_profile_name') {
      const selectedUserId =
        this.adminSelectedUserByTelegramId.get(actorTelegramId);
      const displayName = args.join(' ').trim();

      if (!selectedUserId) {
        await ctx.reply(
          'Сначала откройте профиль через /admin_profile <userId|telegramId>.',
        );
        return true;
      }

      if (!displayName) {
        await ctx.reply('Формат: /admin_profile_name <display_name>');
        return true;
      }

      if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
        await ctx.reply(
          `Имя слишком длинное. Максимум ${DISPLAY_NAME_MAX_LENGTH} символов.`,
        );
        return true;
      }

      try {
        await this.usersService.updateDisplayNameByAdminByUserId({
          actorTelegramId: String(actorTelegramId),
          targetUserId: selectedUserId,
          displayName,
        });
        await this.openAdminUserProfile(ctx, actorTelegramId, selectedUserId);
      } catch {
        await ctx.reply('Не удалось обновить display_name пользователя.');
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

      const showAdminTools = await this.isAdmin(telegramId);

      await ctx.reply(
        confirmationText,
        this.getMainMenuKeyboard(showAdminTools),
      );
    } catch {
      this.flowStateByTelegramId.delete(telegramId);
      const showAdminTools = await this.isAdmin(telegramId);
      await ctx.reply(
        'Не удалось обновить имя. Выполните /start и попробуйте снова.',
        this.getMainMenuKeyboard(showAdminTools),
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
        this.adminSelectedUserByTelegramId.delete(telegramId);
      }
      await this.showMainMenu(ctx, telegramId);
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

    if (trimmedText === MENU_BUTTONS.adminUsers) {
      await this.showAdminUsers(ctx, telegramId);
      return;
    }

    if (trimmedText === MENU_BUTTONS.adminOpenProfile) {
      await this.startAdminProfileLookup(ctx, telegramId);
      return;
    }

    if (trimmedText === MENU_BUTTONS.adminChangeUserRole) {
      await this.startAdminUserRoleChange(ctx, telegramId);
      return;
    }

    if (trimmedText === MENU_BUTTONS.adminChangeUserDisplayName) {
      await this.startAdminUserDisplayNameChange(ctx, telegramId);
      return;
    }

    if (trimmedText.startsWith('/')) {
      this.flowStateByTelegramId.delete(telegramId);
    }

    const currentFlowState = this.flowStateByTelegramId.get(telegramId);
    if (currentFlowState === 'awaiting_admin_profile_target') {
      await this.handleAdminProfileLookupInput(ctx, telegramId, trimmedText);
      return;
    }

    if (currentFlowState === 'awaiting_admin_profile_role') {
      await this.handleAdminUserRoleInput(ctx, telegramId, trimmedText);
      return;
    }

    if (currentFlowState === 'awaiting_admin_profile_display_name') {
      await this.handleAdminUserDisplayNameInput(ctx, telegramId, trimmedText);
      return;
    }

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
