export const CACHE_COLORS = {
  dark: { good: '#19affe', fair: '#fadf27', poor: '#fe626c', warm: '#12efc6', compact: '#8a74ff' },
  light: { good: '#0268d0', fair: '#9d580c', poor: '#7a0d3f', warm: '#0b8a6c', compact: '#5d05a4' },
};

export const CACHE_SURFACES = { dark: ['#000000', '#1e1e1e', '#282c34'], light: ['#ffffff', '#f0f0f0', '#fdf6e3'] };

/**
 * @param {unknown} theme
 * @param {string} [colorfgbg]
 * @returns {'dark' | 'light'}
 */
export function themeFamily(theme, colorfgbg) {
  if (typeof theme === 'string' && theme.startsWith('light')) return 'light';
  if (typeof theme === 'string' && theme.startsWith('dark')) return 'dark';
  const background = typeof colorfgbg === 'string' ? colorfgbg.split(';').at(-1) : undefined;
  return background === '7' || background === '15' ? 'light' : 'dark';
}
