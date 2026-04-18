import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity({ name: 'telegram_accounts' })
export class TelegramAccountEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', unique: true })
  telegramId!: string;

  @Column({ type: 'varchar', nullable: true })
  username?: string | null;

  @Column({ type: 'varchar', nullable: true })
  chatId?: string | null;

  @CreateDateColumn()
  linkedAt!: Date;

  @OneToOne(() => UserEntity, (user) => user.telegramAccount, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;
}
