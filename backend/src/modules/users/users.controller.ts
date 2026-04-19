import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { RegisterUserDto } from './dto/register-user.dto';
import { USER_ROLE_VALUES, UserRole } from './entities/user-role.enum';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async register(@Body() body: RegisterUserDto): Promise<{
    id: string;
    displayName?: string | null;
    roles: UserRole[];
    createdAt: Date;
  }> {
    const user = await this.usersService.registerUser(body.displayName);

    return {
      id: user.id,
      displayName: user.displayName,
      roles: user.roles,
      createdAt: user.createdAt,
    };
  }

  @Post(':userId/telegram/link-code')
  async createTelegramLinkCode(
    @Param('userId') userId: string,
  ): Promise<{ code: string; expiresAt: Date }> {
    const token = await this.usersService.createTelegramLinkCode(userId);

    return {
      code: token.code,
      expiresAt: token.expiresAt,
    };
  }

  @Post('admin/bootstrap')
  async bootstrapAdmin(
    @Body()
    body: {
      token: string;
      targetUserId?: string;
      targetTelegramId?: string;
    },
  ): Promise<{ id: string; roles: UserRole[] }> {
    const user = await this.usersService.bootstrapAdmin(body);

    return {
      id: user.id,
      roles: user.roles,
    };
  }

  @Post('admin/roles')
  async setRole(
    @Body()
    body: {
      actorUserId: string;
      targetUserId?: string;
      targetTelegramId?: string;
      role: string;
      enabled: boolean;
    },
  ): Promise<{ id: string; roles: UserRole[] }> {
    const role = this.parseUserRole(body.role);
    const user = await this.usersService.updateRoleByAdminApi({
      actorUserId: body.actorUserId,
      targetUserId: body.targetUserId,
      targetTelegramId: body.targetTelegramId,
      role,
      enabled: body.enabled,
    });

    return {
      id: user.id,
      roles: user.roles,
    };
  }

  @Post('admin/block')
  async blockUser(
    @Body()
    body: {
      actorUserId: string;
      targetUserId?: string;
      targetTelegramId?: string;
      mode: 'temporary' | 'permanent' | 'unblock';
      durationMinutes?: number;
      reason?: string;
    },
  ): Promise<{
    id: string;
    isBlocked: boolean;
    blockedUntil: Date | null;
    blockReason: string | null;
  }> {
    const user = await this.usersService.blockUserByAdminApi(body);

    return {
      id: user.id,
      isBlocked: user.isBlocked,
      blockedUntil: user.blockedUntil ?? null,
      blockReason: user.blockReason ?? null,
    };
  }

  @Post('admin/role-descriptions')
  async updateRoleDescription(
    @Body()
    body: {
      actorUserId: string;
      role: string;
      description: string;
    },
  ): Promise<{ role: UserRole; description: string; updatedAt: Date }> {
    const role = this.parseUserRole(body.role);
    const roleDescription =
      await this.usersService.updateRoleDescriptionByAdminApi({
        actorUserId: body.actorUserId,
        role,
        description: body.description,
      });

    return {
      role: roleDescription.role,
      description: roleDescription.description,
      updatedAt: roleDescription.updatedAt,
    };
  }

  private parseUserRole(role: string): UserRole {
    const normalizedRole = role?.trim() as UserRole;
    if (!USER_ROLE_VALUES.includes(normalizedRole)) {
      throw new BadRequestException(`Недопустимая роль: ${role}`);
    }

    return normalizedRole;
  }
}
