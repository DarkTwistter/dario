import { readFileSync } from 'node:fs';
let cached: string | undefined;
export function profilesUiPage(): string {
  return cached ??= readFileSync(new URL('./profiles-ui.html', import.meta.url), 'utf8');
}
