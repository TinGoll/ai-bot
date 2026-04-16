import { Injectable } from '@nestjs/common';
import { SmartDevice } from '../../common/types';

@Injectable()
export class DevicesService {
  private readonly devices: SmartDevice[] = [
    { id: 'lamp-kitchen', name: 'Kitchen Lamp', room: 'Kitchen', isOn: false },
    { id: 'ac-bedroom', name: 'Bedroom AC', room: 'Bedroom', isOn: false },
  ];

  getAll(): SmartDevice[] {
    return this.devices;
  }

  toggleLight(id: string): SmartDevice | null {
    const device = this.devices.find((item) => item.id === id);

    if (!device) {
      return null;
    }

    device.isOn = !device.isOn;

    return device;
  }

  setState(id: string, isOn: boolean): SmartDevice | null {
    const device = this.devices.find((item) => item.id === id);

    if (!device) {
      return null;
    }

    device.isOn = isOn;

    return device;
  }
}
