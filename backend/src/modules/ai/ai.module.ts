import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { AiService } from './ai.service';

@Module({
  imports: [DevicesModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
