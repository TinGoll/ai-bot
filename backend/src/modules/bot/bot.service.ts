import { Injectable } from '@nestjs/common';
import { TelegramUpdate } from '../../common/types';
import { AiService } from '../ai/ai.service';
import { USER_ROLE_VALUES, UserRole } from '../users/entities/user-role.enum';
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

    const adminReply = await this.handleAdminCommand(text, data);
    if (adminReply) {
      return adminReply;
    }

    if (data.telegramId) {
      const blockStatus = await this.usersService.getBlockStatusByTelegramId(
        String(data.telegramId),
      );
      if (blockStatus?.isBlocked) {
        const blockedUntilText = blockStatus.blockedUntil
          ? ` до ${blockStatus.blockedUntil.toLocaleString('ru-RU')}`
          : ' бессрочно';
        const reasonText = blockStatus.blockReason
          ? ` Причина: ${blockStatus.blockReason}`
          : '';
        return `Ваш доступ ограничен${blockedUntilText}.${reasonText}`;
      }
    }

    if (text.startsWith('/link')) {
      return this.handleLinkCommand(text, data);
    }

    const userContext = data.telegramId
      ? await this.usersService.getAiPersonalizationContextByTelegramId(
          String(data.telegramId),
        )
      : null;

    return this.handleTelegramText(text, data.conversationId, userContext);
  }

  async handleTelegramText(
    text?: string,
    conversationId = 'telegram:unknown',
    userContext?: {
      isFamilyMember: boolean;
      displayName: string | null;
      adminDescription: string | null;
    } | null,
  ): Promise<string | null> {
    if (!text) {
      return null;
    }

    const history = this.historyByConversation.get(conversationId) ?? [];
    const reply = await this.aiService.generateReply(
      text,
      history,
      userContext ?? undefined,
    );

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

  private parseRole(role: string): UserRole | null {
    const normalizedRole = role.trim() as UserRole;
    if (!USER_ROLE_VALUES.includes(normalizedRole)) {
      return null;
    }

    return normalizedRole;
  }

  private async handleAdminCommand(
    text: string,
    data: { telegramId?: number },
  ): Promise<string | null> {
    if (!text.startsWith('/admin_')) {
      return null;
    }

    if (!data.telegramId) {
      return 'Не удалось определить Telegram-аккаунт.';
    }

    const [command, ...args] = text.split(' ');
    if (command === '/admin_help') {
      return [
        'Команды администратора:',
        '/admin_set_role <telegramId> <role> <on|off>',
        '/admin_block <telegramId> <permanent|minutes> [reason]',
        '/admin_unblock <telegramId>',
        '/admin_role_desc <role> <description>',
        '/admin_users',
        '/admin_profile <userId|telegramId>',
      ].join('\n');
    }

    if (command === '/admin_set_role') {
      const [targetTelegramId, roleRaw, modeRaw] = args;
      const role = roleRaw ? this.parseRole(roleRaw) : null;
      const enabled = modeRaw === 'on';
      const disabled = modeRaw === 'off';
      if (!targetTelegramId || !role || (!enabled && !disabled)) {
        return 'Формат: /admin_set_role <telegramId> <role> <on|off>';
      }

      try {
        const user = await this.usersService.setUserRoleByAdmin({
          actorTelegramId: String(data.telegramId),
          targetTelegramId,
          role,
          enabled,
        });
        return `Роли пользователя ${user.id}: ${user.roles.join(', ')}`;
      } catch {
        return 'Не удалось изменить роль. Проверьте права и параметры.';
      }
    }

    if (command === '/admin_block') {
      const [targetTelegramId, modeRaw, ...reasonParts] = args;
      if (!targetTelegramId || !modeRaw) {
        return 'Формат: /admin_block <telegramId> <permanent|minutes> [reason]';
      }

      const mode: 'temporary' | 'permanent' =
        modeRaw === 'permanent' ? 'permanent' : 'temporary';
      const durationMinutes =
        mode === 'temporary' ? Number.parseInt(modeRaw, 10) : undefined;
      if (mode === 'temporary' && (!durationMinutes || durationMinutes <= 0)) {
        return 'Для временной блокировки укажите число минут больше 0.';
      }

      try {
        const user = await this.usersService.blockUserByAdmin({
          actorTelegramId: String(data.telegramId),
          targetTelegramId,
          mode,
          durationMinutes,
          reason: reasonParts.join(' ').trim() || undefined,
        });
        const suffix =
          user.blockedUntil && mode === 'temporary'
            ? ` до ${user.blockedUntil.toLocaleString('ru-RU')}`
            : '';
        return `Пользователь ${user.id} заблокирован${suffix}.`;
      } catch {
        return 'Не удалось выполнить блокировку. Проверьте права и параметры.';
      }
    }

    if (command === '/admin_unblock') {
      const [targetTelegramId] = args;
      if (!targetTelegramId) {
        return 'Формат: /admin_unblock <telegramId>';
      }

      try {
        const user = await this.usersService.blockUserByAdmin({
          actorTelegramId: String(data.telegramId),
          targetTelegramId,
          mode: 'unblock',
        });
        return `Пользователь ${user.id} разблокирован.`;
      } catch {
        return 'Не удалось снять блокировку. Проверьте права и параметры.';
      }
    }

    if (command === '/admin_role_desc') {
      const [roleRaw, ...descriptionParts] = args;
      const role = roleRaw ? this.parseRole(roleRaw) : null;
      const description = descriptionParts.join(' ').trim();

      if (!role || !description) {
        return 'Формат: /admin_role_desc <role> <description>';
      }

      try {
        const roleDescription =
          await this.usersService.updateRoleDescriptionByAdmin({
            actorTelegramId: String(data.telegramId),
            role,
            description,
          });
        return `Описание роли ${roleDescription.role} обновлено: ${roleDescription.description}`;
      } catch {
        return 'Не удалось обновить описание роли. Проверьте права и параметры.';
      }
    }

    if (command === '/admin_users') {
      try {
        const users = await this.usersService.getAllUsersByAdmin({
          actorTelegramId: String(data.telegramId),
        });

        if (!users.length) {
          return 'Пользователи не найдены.';
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

        return lines.join('\n');
      } catch {
        return 'Команда доступна только администратору.';
      }
    }

    if (command === '/admin_profile') {
      const [target] = args;
      if (!target) {
        return 'Формат: /admin_profile <userId|telegramId>';
      }

      try {
        const profile = await this.usersService.getUserProfileByAdmin({
          actorTelegramId: String(data.telegramId),
          target,
        });

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
        ].join('\n');
      } catch {
        return 'Не удалось открыть профиль. Проверьте идентификатор.';
      }
    }

    return 'Неизвестная команда администратора. Используйте /admin_help';
  }
}
