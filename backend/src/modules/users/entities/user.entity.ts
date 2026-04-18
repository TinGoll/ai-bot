import {
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TelegramAccountEntity } from './telegram-account.entity';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  displayName?: string | null;

  @OneToOne(
    () => TelegramAccountEntity,
    (telegramAccount) => telegramAccount.user,
  )
  telegramAccount?: TelegramAccountEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
