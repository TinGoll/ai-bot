export interface HealthCheckDto {
  status: 'ok';
  service: 'backend' | 'frontend';
  timestamp: string;
}
