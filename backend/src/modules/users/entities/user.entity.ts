import {
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TelegramAccountEntity } from './telegram-account.entity';
import { UserRole } from './user-role.enum';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  displayName?: string | null;

  @Column({ type: 'simple-array', default: UserRole.GUEST })
  roles!: UserRole[];

  @Column({ type: 'boolean', default: false })
  isBlocked!: boolean;

  @Column({ type: 'datetime', nullable: true })
  blockedUntil?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  blockReason?: string | null;

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
