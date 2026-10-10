import { readFileSync } from 'node:fs';

/** Shared finalized application mark. Data URI avoids host access to local files or a new image endpoint. */
const appIcon = `data:image/png;base64,${readFileSync(new URL('../docs/素材/星渡/星渡-应用-128.png', import.meta.url)).toString('base64')}`;

export function xingduIcons() {
  // No theme: the existing opaque charcoal application mark is the approved mark for both themes.
  return [{ src: appIcon, mimeType: 'image/png', sizes: ['128x128'] }];
}
