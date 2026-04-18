import { Body, Controller, Param, Post } from '@nestjs/common';
import { RegisterUserDto } from './dto/register-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async register(
    @Body() body: RegisterUserDto,
  ): Promise<{ id: string; displayName?: string | null; createdAt: Date }> {
    const user = await this.usersService.registerUser(body.displayName);

    return {
      id: user.id,
      displayName: user.displayName,
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
}
