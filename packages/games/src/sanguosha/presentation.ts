/**
 * 三国杀的身份词汇。
 *
 * 通用层只知道每个玩家有一个 role token；把 token 变成中文身份名、并决定
 * 哪张角色卡上写什么，属于本包。以前这张表住在 packages/app 的通用层里。
 */
const ROLE_LABELS: Record<string, string> = {
  LORD: '主公',
  LOYALIST: '忠臣',
  REBEL: '反贼',
  SPY: '内奸'
};

export function sanguoshaRoleLabel(role: string): string | null {
  return ROLE_LABELS[role] ?? null;
}
