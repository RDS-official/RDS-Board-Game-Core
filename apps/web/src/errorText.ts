/**
 * 把 `catch` 里抓到的任意值转成可展示的文本。
 *
 * 以前各处写 `catch (e: any) { … e.message }`，等于在错误路径上放弃类型检查；
 * 统一走这里之后，`catch` 可以不写类型（issue #234）。
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? '未知错误');
}
