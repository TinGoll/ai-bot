import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { RoleDescriptionEntity } from './entities/role-description.entity';
import { TelegramAccountEntity } from './entities/telegram-account.entity';
import { TelegramLinkTokenEntity } from './entities/telegram-link-token.entity';
import { UserEntity } from './entities/user.entity';
import {
  DEFAULT_ROLE_DESCRIPTIONS,
  USER_ROLE_VALUES,
  UserRole,
} from './entities/user-role.enum';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly linkTokenTtlMs = 15 * 60 * 1000;
  private readonly logger = new Logger(UsersService.name);
  private readonly initialAdminTelegramIds = new Set(
    (process.env.INITIAL_ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  private readonly initialAdminUserIds = new Set(
    (process.env.INITIAL_ADMIN_USER_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  private readonly bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(TelegramAccountEntity)
    private readonly telegramAccountRepository: Repository<TelegramAccountEntity>,
    @InjectRepository(TelegramLinkTokenEntity)
    private readonly telegramLinkTokenRepository: Repository<TelegramLinkTokenEntity>,
    @InjectRepository(RoleDescriptionEntity)
    private readonly roleDescriptionRepository: Repository<RoleDescriptionEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureRoleDescriptions();
  }

  async registerUser(displayName?: string): Promise<UserEntity> {
    const user = this.userRepository.create({
      displayName: displayName?.trim() || null,
      roles: [UserRole.GUEST],
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

      await this.applyInitialAdminRole(existingAccount.user, data.telegramId);

      return { user: existingAccount.user, isNewUser: false };
    }

    const user = await this.registerUser(data.username);
    await this.applyInitialAdminRole(user, data.telegramId);
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
    roles: UserRole[];
    roleDescriptions: Array<{ role: UserRole; description: string }>;
    isBlocked: boolean;
    blockedUntil: Date | null;
    blockReason: string | null;
    createdAt: Date;
  } | null> {
    const account = await this.telegramAccountRepository.findOne({
      where: { telegramId },
      relations: { user: true },
    });

    if (!account) {
      return null;
    }

    const normalizedRoles = this.normalizeRoles(account.user.roles);
    if (!this.areRolesEqual(account.user.roles, normalizedRoles)) {
      account.user.roles = normalizedRoles;
      await this.userRepository.save(account.user);
    }

    const roleDescriptions =
      await this.getRoleDescriptionsByRoles(normalizedRoles);
    const blockState = await this.resolveUserBlockState(account.user);

    return {
      username: account.username ?? null,
      displayName: account.user.displayName ?? null,
      roles: normalizedRoles,
      roleDescriptions,
      isBlocked: blockState.isBlocked,
      blockedUntil: blockState.blockedUntil,
      blockReason: blockState.blockReason,
      createdAt: account.user.createdAt,
    };
  }

  async getBlockStatusByTelegramId(telegramId: string): Promise<{
    isBlocked: boolean;
    blockedUntil: Date | null;
    blockReason: string | null;
  } | null> {
    const account = await this.telegramAccountRepository.findOne({
      where: { telegramId },
      relations: { user: true },
    });

    if (!account) {
      return null;
    }

    return this.resolveUserBlockState(account.user);
  }

  async updateRoleDescriptionByAdmin(data: {
    actorTelegramId: string;
    role: UserRole;
    description: string;
  }): Promise<RoleDescriptionEntity> {
    const actor = await this.requireAdminByTelegramId(data.actorTelegramId);
    const roleDescription = await this.roleDescriptionRepository.findOne({
      where: { role: data.role },
    });

    const nextDescription = data.description.trim();
    if (!nextDescription) {
      throw new BadRequestException('Описание роли не может быть пустым');
    }

    const entity =
      roleDescription ??
      this.roleDescriptionRepository.create({ role: data.role });
    entity.description = nextDescription;
    const saved = await this.roleDescriptionRepository.save(entity);

    this.logAdminAction(actor.id, `updated role description for ${data.role}`);

    return saved;
  }

  async setUserRoleByAdmin(data: {
    actorTelegramId: string;
    targetTelegramId: string;
    role: UserRole;
    enabled: boolean;
  }): Promise<UserEntity> {
    const actor = await this.requireAdminByTelegramId(data.actorTelegramId);
    const target = await this.getUserByTelegramIdOrFail(data.targetTelegramId);
    target.roles = this.toggleRole(target.roles, data.role, data.enabled);

    const saved = await this.userRepository.save(target);
    this.logAdminAction(
      actor.id,
      `${data.enabled ? 'enabled' : 'disabled'} role ${data.role} for user ${target.id}`,
    );

    return saved;
  }

  async setUserRoleByAdminByUserId(data: {
    actorTelegramId: string;
    targetUserId: string;
    role: UserRole;
    enabled: boolean;
  }): Promise<UserEntity> {
    const actor = await this.requireAdminByTelegramId(data.actorTelegramId);
    const target = await this.getUserByIdOrFail(data.targetUserId);
    target.roles = this.toggleRole(target.roles, data.role, data.enabled);

    const saved = await this.userRepository.save(target);
    this.logAdminAction(
      actor.id,
      `${data.enabled ? 'enabled' : 'disabled'} role ${data.role} for user ${target.id}`,
    );

    return saved;
  }

  async updateDisplayNameByAdminByUserId(data: {
    actorTelegramId: string;
    targetUserId: string;
    displayName: string;
  }): Promise<{
    id: string;
    previousDisplayName: string | null;
    updatedDisplayName: string;
  }> {
    const actor = await this.requireAdminByTelegramId(data.actorTelegramId);
    const target = await this.getUserByIdOrFail(data.targetUserId);
    const nextDisplayName = data.displayName.trim();

    if (!nextDisplayName) {
      throw new BadRequestException('display_name не может быть пустым');
    }

    const previousDisplayName = target.displayName ?? null;
    target.displayName = nextDisplayName;
    await this.userRepository.save(target);

    this.logAdminAction(
      actor.id,
      `updated display_name for user ${target.id} to "${nextDisplayName}"`,
    );

    return {
      id: target.id,
      previousDisplayName,
      updatedDisplayName: nextDisplayName,
    };
  }

  async blockUserByAdmin(data: {
    actorTelegramId: string;
    targetTelegramId: string;
    mode: 'temporary' | 'permanent' | 'unblock';
    durationMinutes?: number;
    reason?: string;
  }): Promise<UserEntity> {
    const actor = await this.requireAdminByTelegramId(data.actorTelegramId);
    const target = await this.getUserByTelegramIdOrFail(data.targetTelegramId);

    if (data.mode === 'unblock') {
      target.isBlocked = false;
      target.blockedUntil = null;
      target.blockReason = null;
      const saved = await this.userRepository.save(target);
      this.logAdminAction(actor.id, `unblocked user ${target.id}`);
      return saved;
    }

    if (
      data.mode === 'temporary' &&
      (!data.durationMinutes || data.durationMinutes <= 0)
    ) {
      throw new BadRequestException('durationMinutes должен быть больше 0');
    }

    target.isBlocked = true;
    target.blockReason = data.reason?.trim() || null;
    target.blockedUntil =
      data.mode === 'temporary'
        ? new Date(Date.now() + (data.durationMinutes ?? 0) * 60 * 1000)
        : null;

    const saved = await this.userRepository.save(target);
    this.logAdminAction(
      actor.id,
      `${data.mode} block for user ${target.id}${target.blockReason ? ` (${target.blockReason})` : ''}`,
    );

    return saved;
  }

  async bootstrapAdmin(data: {
    token: string;
    targetTelegramId?: string;
    targetUserId?: string;
  }): Promise<UserEntity> {
    if (!this.bootstrapToken || data.token.trim() !== this.bootstrapToken) {
      throw new ForbiddenException('Неверный bootstrap-токен');
    }

    const adminsCount = await this.userRepository
      .createQueryBuilder('user')
      .where('user.roles LIKE :adminRole', { adminRole: `%${UserRole.ADMIN}%` })
      .getCount();
    if (adminsCount > 0) {
      throw new ConflictException('Администратор уже назначен');
    }

    const target = await this.resolveTargetUser({
      targetTelegramId: data.targetTelegramId,
      targetUserId: data.targetUserId,
    });

    target.roles = this.toggleRole(target.roles, UserRole.ADMIN, true);
    const saved = await this.userRepository.save(target);
    this.logAdminAction(saved.id, `bootstrap admin for user ${saved.id}`);

    return saved;
  }

  async updateRoleByAdminApi(data: {
    actorUserId: string;
    targetUserId?: string;
    targetTelegramId?: string;
    role: UserRole;
    enabled: boolean;
  }): Promise<UserEntity> {
    const actor = await this.requireAdminByUserId(data.actorUserId);
    const target = await this.resolveTargetUser(data);

    target.roles = this.toggleRole(target.roles, data.role, data.enabled);
    const saved = await this.userRepository.save(target);
    this.logAdminAction(
      actor.id,
      `${data.enabled ? 'enabled' : 'disabled'} role ${data.role} for user ${target.id}`,
    );

    return saved;
  }

  async blockUserByAdminApi(data: {
    actorUserId: string;
    targetUserId?: string;
    targetTelegramId?: string;
    mode: 'temporary' | 'permanent' | 'unblock';
    durationMinutes?: number;
    reason?: string;
  }): Promise<UserEntity> {
    const actor = await this.requireAdminByUserId(data.actorUserId);
    const target = await this.resolveTargetUser(data);

    if (data.mode === 'unblock') {
      target.isBlocked = false;
      target.blockedUntil = null;
      target.blockReason = null;
      const saved = await this.userRepository.save(target);
      this.logAdminAction(actor.id, `unblocked user ${target.id}`);
      return saved;
    }

    if (
      data.mode === 'temporary' &&
      (!data.durationMinutes || data.durationMinutes <= 0)
    ) {
      throw new BadRequestException('durationMinutes должен быть больше 0');
    }

    target.isBlocked = true;
    target.blockReason = data.reason?.trim() || null;
    target.blockedUntil =
      data.mode === 'temporary'
        ? new Date(Date.now() + (data.durationMinutes ?? 0) * 60 * 1000)
        : null;

    const saved = await this.userRepository.save(target);
    this.logAdminAction(
      actor.id,
      `${data.mode} block for user ${target.id}${target.blockReason ? ` (${target.blockReason})` : ''}`,
    );

    return saved;
  }

  async updateRoleDescriptionByAdminApi(data: {
    actorUserId: string;
    role: UserRole;
    description: string;
  }): Promise<RoleDescriptionEntity> {
    const actor = await this.requireAdminByUserId(data.actorUserId);
    const nextDescription = data.description.trim();
    if (!nextDescription) {
      throw new BadRequestException('Описание роли не может быть пустым');
    }

    const existing = await this.roleDescriptionRepository.findOne({
      where: { role: data.role },
    });
    const roleDescription =
      existing ?? this.roleDescriptionRepository.create({ role: data.role });
    roleDescription.description = nextDescription;

    const saved = await this.roleDescriptionRepository.save(roleDescription);
    this.logAdminAction(actor.id, `updated role description for ${data.role}`);

    return saved;
  }

  async getAllUsersByAdmin(data: { actorTelegramId: string }): Promise<
    Array<{
      id: string;
      telegramId: string | null;
      username: string | null;
      displayName: string | null;
      roles: UserRole[];
      isBlocked: boolean;
      blockedUntil: Date | null;
      blockReason: string | null;
      createdAt: Date;
    }>
  > {
    await this.requireAdminByTelegramId(data.actorTelegramId);

    const users = await this.userRepository.find({
      relations: { telegramAccount: true },
      order: { createdAt: 'DESC' },
    });

    const result: Array<{
      id: string;
      telegramId: string | null;
      username: string | null;
      displayName: string | null;
      roles: UserRole[];
      isBlocked: boolean;
      blockedUntil: Date | null;
      blockReason: string | null;
      createdAt: Date;
    }> = [];

    for (const user of users) {
      const normalizedRoles = this.normalizeRoles(user.roles);
      if (!this.areRolesEqual(user.roles, normalizedRoles)) {
        user.roles = normalizedRoles;
        await this.userRepository.save(user);
      }

      const blockState = await this.resolveUserBlockState(user);
      result.push({
        id: user.id,
        telegramId: user.telegramAccount?.telegramId ?? null,
        username: user.telegramAccount?.username ?? null,
        displayName: user.displayName ?? null,
        roles: normalizedRoles,
        isBlocked: blockState.isBlocked,
        blockedUntil: blockState.blockedUntil,
        blockReason: blockState.blockReason,
        createdAt: user.createdAt,
      });
    }

    return result;
  }

  async getUserProfileByAdmin(data: {
    actorTelegramId: string;
    target: string;
  }): Promise<{
    id: string;
    telegramId: string | null;
    username: string | null;
    displayName: string | null;
    roles: UserRole[];
    roleDescriptions: Array<{ role: UserRole; description: string }>;
    isBlocked: boolean;
    blockedUntil: Date | null;
    blockReason: string | null;
    createdAt: Date;
  }> {
    await this.requireAdminByTelegramId(data.actorTelegramId);

    const target = data.target.trim();
    if (!target) {
      throw new BadRequestException(
        'Укажите userId или telegramId пользователя',
      );
    }

    let user = await this.userRepository.findOne({
      where: { id: target },
      relations: { telegramAccount: true },
    });

    if (!user) {
      const account = await this.telegramAccountRepository.findOne({
        where: { telegramId: target },
        relations: { user: true },
      });

      if (!account) {
        throw new NotFoundException('Пользователь не найден');
      }

      user = await this.userRepository.findOne({
        where: { id: account.user.id },
        relations: { telegramAccount: true },
      });
    }

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    const normalizedRoles = this.normalizeRoles(user.roles);
    if (!this.areRolesEqual(user.roles, normalizedRoles)) {
      user.roles = normalizedRoles;
      await this.userRepository.save(user);
    }

    const roleDescriptions =
      await this.getRoleDescriptionsByRoles(normalizedRoles);
    const blockState = await this.resolveUserBlockState(user);

    return {
      id: user.id,
      telegramId: user.telegramAccount?.telegramId ?? null,
      username: user.telegramAccount?.username ?? null,
      displayName: user.displayName ?? null,
      roles: normalizedRoles,
      roleDescriptions,
      isBlocked: blockState.isBlocked,
      blockedUntil: blockState.blockedUntil,
      blockReason: blockState.blockReason,
      createdAt: user.createdAt,
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

  private normalizeRoles(roles?: UserRole[] | null): UserRole[] {
    const unique = Array.from(new Set((roles ?? []).filter(Boolean)));
    const valid = unique.filter((role) => USER_ROLE_VALUES.includes(role));
    const hasPrivilegedRole =
      valid.includes(UserRole.ADMIN) || valid.includes(UserRole.FAMILY_MEMBER);

    if (hasPrivilegedRole) {
      return valid.filter((role) => role !== UserRole.GUEST);
    }

    return valid.length ? valid : [UserRole.GUEST];
  }

  private toggleRole(
    roles: UserRole[] | null | undefined,
    role: UserRole,
    enabled: boolean,
  ): UserRole[] {
    const normalized = this.normalizeRoles(roles);
    const withRole = enabled
      ? this.normalizeRoles([...normalized, role])
      : this.normalizeRoles(
          normalized.filter((existingRole) => existingRole !== role),
        );

    return withRole;
  }

  private areRolesEqual(
    left?: UserRole[] | null,
    right?: UserRole[] | null,
  ): boolean {
    const a = this.normalizeRoles(left);
    const b = this.normalizeRoles(right);

    if (a.length !== b.length) {
      return false;
    }

    return a.every((role, index) => role === b[index]);
  }

  private async ensureRoleDescriptions(): Promise<void> {
    const existing = await this.roleDescriptionRepository.find();
    const existingByRole = new Map(existing.map((item) => [item.role, item]));

    const entitiesToCreate = USER_ROLE_VALUES.filter(
      (role) => !existingByRole.has(role),
    ).map((role) =>
      this.roleDescriptionRepository.create({
        role,
        description: DEFAULT_ROLE_DESCRIPTIONS[role],
      }),
    );

    if (entitiesToCreate.length) {
      await this.roleDescriptionRepository.save(entitiesToCreate);
    }
  }

  private async getRoleDescriptionsByRoles(
    roles: UserRole[],
  ): Promise<Array<{ role: UserRole; description: string }>> {
    const descriptions = await this.roleDescriptionRepository.find({
      where: roles.map((role) => ({ role })),
    });
    const descriptionByRole = new Map(
      descriptions.map((item) => [item.role, item.description]),
    );

    return roles.map((role) => ({
      role,
      description:
        descriptionByRole.get(role) ?? DEFAULT_ROLE_DESCRIPTIONS[role],
    }));
  }

  private async resolveUserBlockState(user: UserEntity): Promise<{
    isBlocked: boolean;
    blockedUntil: Date | null;
    blockReason: string | null;
  }> {
    if (!user.isBlocked) {
      return {
        isBlocked: false,
        blockedUntil: null,
        blockReason: null,
      };
    }

    if (user.blockedUntil && user.blockedUntil.getTime() <= Date.now()) {
      user.isBlocked = false;
      user.blockedUntil = null;
      user.blockReason = null;
      await this.userRepository.save(user);

      return {
        isBlocked: false,
        blockedUntil: null,
        blockReason: null,
      };
    }

    return {
      isBlocked: true,
      blockedUntil: user.blockedUntil ?? null,
      blockReason: user.blockReason ?? null,
    };
  }

  private async applyInitialAdminRole(
    user: UserEntity,
    telegramId: string,
  ): Promise<void> {
    const shouldBeAdmin =
      this.initialAdminTelegramIds.has(telegramId) ||
      this.initialAdminUserIds.has(user.id);
    if (!shouldBeAdmin) {
      return;
    }

    const nextRoles = this.toggleRole(user.roles, UserRole.ADMIN, true);
    if (this.areRolesEqual(user.roles, nextRoles)) {
      return;
    }

    user.roles = nextRoles;
    await this.userRepository.save(user);
    this.logAdminAction(
      user.id,
      `initial admin role granted via environment config`,
    );
  }

  private async requireAdminByTelegramId(
    telegramId: string,
  ): Promise<UserEntity> {
    const user = await this.getUserByTelegramIdOrFail(telegramId);
    if (!this.normalizeRoles(user.roles).includes(UserRole.ADMIN)) {
      throw new ForbiddenException('Операция доступна только администратору');
    }

    return user;
  }

  private async requireAdminByUserId(userId: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Пользователь-инициатор не найден');
    }

    if (!this.normalizeRoles(user.roles).includes(UserRole.ADMIN)) {
      throw new ForbiddenException('Операция доступна только администратору');
    }

    return user;
  }

  private async getUserByTelegramIdOrFail(
    telegramId: string,
  ): Promise<UserEntity> {
    const account = await this.telegramAccountRepository.findOne({
      where: { telegramId },
      relations: { user: true },
    });
    if (!account) {
      throw new NotFoundException(
        'Пользователь с указанным Telegram ID не найден',
      );
    }

    return account.user;
  }

  private async getUserByIdOrFail(userId: string): Promise<UserEntity> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new BadRequestException('Укажите userId пользователя');
    }

    const user = await this.userRepository.findOne({
      where: { id: normalizedUserId },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    return user;
  }

  private async resolveTargetUser(data: {
    targetUserId?: string;
    targetTelegramId?: string;
  }): Promise<UserEntity> {
    const targetUserId = data.targetUserId?.trim();
    const targetTelegramId = data.targetTelegramId?.trim();

    if (!targetUserId && !targetTelegramId) {
      throw new BadRequestException(
        'Укажите targetUserId или targetTelegramId',
      );
    }

    if (targetUserId) {
      const user = await this.userRepository.findOne({
        where: { id: targetUserId },
      });
      if (!user) {
        throw new NotFoundException('Целевой пользователь не найден');
      }

      return user;
    }

    return this.getUserByTelegramIdOrFail(targetTelegramId as string);
  }

  private logAdminAction(actorUserId: string, action: string): void {
    this.logger.log(`[admin_action] actor=${actorUserId} action="${action}"`);
  }
}
