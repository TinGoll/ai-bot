import { NestFactory } from '@nestjs/core';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';

async function bootstrap() {
  const databasePath = process.env.DATABASE_PATH ?? 'data/app.sqlite';
  const databaseDir = dirname(resolve(databasePath));
  mkdirSync(databaseDir, { recursive: true });

  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
