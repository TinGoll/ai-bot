import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { TelegramAccountEntity } from './entities/telegram-account.entity';
import { TelegramLinkTokenEntity } from './entities/telegram-link-token.entity';
import { UserEntity } from './entities/user.entity';

@Injectable()
export class UsersService {
  private readonly linkTokenTtlMs = 15 * 60 * 1000;

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(TelegramAccountEntity)
    private readonly telegramAccountRepository: Repository<TelegramAccountEntity>,
    @InjectRepository(TelegramLinkTokenEntity)
    private readonly telegramLinkTokenRepository: Repository<TelegramLinkTokenEntity>,
  ) {}

  async registerUser(displayName?: string): Promise<UserEntity> {
    const user = this.userRepository.create({
      displayName: displayName?.trim() || null,
    });

    return this.userRepository.save(user);
  }

  async createTelegramLinkCode(
    userId: string,
  ): Promise<TelegramLinkTokenEntity> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    const existingLink = await this.telegramAccountRepository.findOne({
      where: { user: { id: userId } },
    });
    if (existingLink) {
      throw new ConflictException('Пользователь уже привязан к Telegram');
    }

    await this.telegramLinkTokenRepository
      .createQueryBuilder()
      .delete()
      .where('userId = :userId', { userId })
      .andWhere('usedAt IS NULL')
      .execute();

    const code = await this.generateUniqueLinkCode();
    const expiresAt = new Date(Date.now() + this.linkTokenTtlMs);
    const linkToken = this.telegramLinkTokenRepository.create({
      code,
      expiresAt,
      user,
    });

    return this.telegramLinkTokenRepository.save(linkToken);
  }

  async registerOrGetByTelegram(data: {
    telegramId: string;
    username?: string;
    chatId?: string;
  }): Promise<{ user: UserEntity; isNewUser: boolean }> {
    const existingAccount = await this.telegramAccountRepository.findOne({
      where: { telegramId: data.telegramId },
      relations: { user: true },
    });

    if (existingAccount) {
      existingAccount.username = data.username ?? existingAccount.username;
      existingAccount.chatId = data.chatId ?? existingAccount.chatId;
      await this.telegramAccountRepository.save(existingAccount);

      return { user: existingAccount.user, isNewUser: false };
    }

    const user = await this.registerUser(data.username);
    const account = this.telegramAccountRepository.create({
      telegramId: data.telegramId,
      username: data.username,
      chatId: data.chatId,
      user,
    });
    await this.telegramAccountRepository.save(account);

    return { user, isNewUser: true };
  }

  async getProfileByTelegramId(telegramId: string): Promise<{
    username: string | null;
    displayName: string | null;
    createdAt: Date;
  } | null> {
    const account = await this.telegramAccountRepository.findOne({
      where: { telegramId },
      relations: { user: true },
    });

    if (!account) {
      return null;
    }

    return {
      username: account.username ?? null,
      displayName: account.user.displayName ?? null,
      createdAt: account.user.createdAt,
    };
  }

  async updateDisplayNameByTelegramId(
    telegramId: string,
    displayName: string,
  ): Promise<{
    previousDisplayName: string | null;
    updatedDisplayName: string;
  }> {
    const account = await this.telegramAccountRepository.findOne({
      where: { telegramId },
      relations: { user: true },
    });

    if (!account) {
      throw new NotFoundException('Пользователь Telegram не найден');
    }

    const trimmedDisplayName = displayName.trim();
    const previousDisplayName = account.user.displayName ?? null;

    account.user.displayName = trimmedDisplayName;
    await this.userRepository.save(account.user);

    return {
      previousDisplayName,
      updatedDisplayName: trimmedDisplayName,
    };
  }

  async linkTelegramByCode(data: {
    code: string;
    telegramId: string;
    username?: string;
    chatId?: string;
  }): Promise<UserEntity> {
    const token = await this.telegramLinkTokenRepository.findOne({
      where: {
        code: data.code,
        usedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      relations: { user: true },
    });

    if (!token) {
      throw new BadRequestException('Код привязки недействителен или истёк');
    }

    const alreadyLinkedByTelegram =
      await this.telegramAccountRepository.findOne({
        where: { telegramId: data.telegramId },
        relations: { user: true },
      });
    if (
      alreadyLinkedByTelegram &&
      alreadyLinkedByTelegram.user.id !== token.user.id
    ) {
      throw new ConflictException(
        'Этот Telegram-аккаунт уже связан с другим пользователем',
      );
    }

    const existingTargetUserLink = await this.telegramAccountRepository.findOne(
      {
        where: { user: { id: token.user.id } },
        relations: { user: true },
      },
    );
    if (
      existingTargetUserLink &&
      existingTargetUserLink.telegramId !== data.telegramId
    ) {
      throw new ConflictException(
        'Пользователь уже связан с другим Telegram-аккаунтом',
      );
    }

    const account =
      alreadyLinkedByTelegram ??
      this.telegramAccountRepository.create({
        telegramId: data.telegramId,
        user: token.user,
      });

    account.username = data.username ?? account.username;
    account.chatId = data.chatId ?? account.chatId;
    account.user = token.user;
    await this.telegramAccountRepository.save(account);

    token.usedAt = new Date();
    await this.telegramLinkTokenRepository.save(token);

    return token.user;
  }

  private async generateUniqueLinkCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      const existingToken = await this.telegramLinkTokenRepository.findOne({
        where: {
          code,
          usedAt: IsNull(),
          expiresAt: MoreThan(new Date()),
        },
      });
      if (!existingToken) {
        return code;
      }
    }

    throw new ConflictException('Не удалось сгенерировать код привязки');
  }
}
