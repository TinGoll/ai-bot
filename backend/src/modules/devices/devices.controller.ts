import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import type { SmartDevice } from '../../common/types';
import { DevicesService } from './devices.service';

interface UpdateDeviceStateDto {
  isOn: boolean;
}

@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  getAll(): SmartDevice[] {
    return this.devicesService.getAll();
  }

  @Patch(':id/state')
  updateState(
    @Param('id') id: string,
    @Body() body: UpdateDeviceStateDto,
  ): SmartDevice {
    const updatedDevice = this.devicesService.setState(id, body.isOn);

    if (!updatedDevice) {
      throw new NotFoundException(`Device with id "${id}" was not found`);
    }

    return updatedDevice;
  }
}
