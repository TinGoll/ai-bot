export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmChatRequest {
  messages: LlmMessage[];
}

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramUpdate {
  message?: TelegramMessage;
}

export interface SmartDevice {
  id: string;
  name: string;
  room: string;
  isOn: boolean;
}
