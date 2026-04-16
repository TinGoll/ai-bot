import { DevicesService } from './devices.service';

describe('DevicesService', () => {
  let service: DevicesService;

  beforeEach(() => {
    service = new DevicesService();
  });

  it('should toggle light state by id', () => {
    const firstState = service
      .getAll()
      .find((device) => device.id === 'lamp-kitchen');
    expect(firstState?.isOn).toBe(false);

    const updatedDevice = service.toggleLight('lamp-kitchen');
    expect(updatedDevice?.isOn).toBe(true);

    const toggledBackDevice = service.toggleLight('lamp-kitchen');
    expect(toggledBackDevice?.isOn).toBe(false);
  });

  it('should return null for unknown device id', () => {
    expect(service.toggleLight('missing-device')).toBeNull();
  });
});
