export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'vs.theme';
const media = matchMedia('(prefers-color-scheme: light)');

let pref: ThemePref = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
})();

export const themePref = () => pref;

/**
 * Apply the saved theme and follow the system while it is set to 'system'.
 * `onChange` runs after every switch (canvases read their colours from CSS).
 * Returns a setter for the preference.
 */
export function initTheme(onChange: () => void) {
  const apply = () => {
    const theme = pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#111317');
    onChange();
  };
  media.addEventListener('change', () => { if (pref === 'system') apply(); });
  apply();
  return (next: ThemePref) => {
    pref = next;
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch { /* storage blocked: applies for this session only */ }
    apply();
  };
}
