import { readFileSync } from 'node:fs';

let page: string | undefined;

/** Public login shell. Account data and mutations use the authenticated admin API. */
export function homeUiPage(): string {
  return page ??= readFileSync(new URL('./home-ui.html', import.meta.url), 'utf8');
}
