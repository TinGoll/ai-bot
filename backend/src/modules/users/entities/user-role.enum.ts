export enum UserRole {
  ADMIN = 'administrator',
  FAMILY_MEMBER = 'family_member',
  GUEST = 'guest',
}

export const USER_ROLE_VALUES = Object.values(UserRole);

export const DEFAULT_ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  [UserRole.ADMIN]:
    'Администратор управляет ролями пользователей, блокировками и настройками сообщества.',
  [UserRole.FAMILY_MEMBER]:
    'Член семьи получает полный доступ к функциям, доступным для участников семьи.',
  [UserRole.GUEST]:
    'Гость использует базовые возможности бота с ограниченным доступом.',
};
