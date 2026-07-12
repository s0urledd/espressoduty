import type { Config } from 'tailwindcss';

// Palette lifted from stake.espresso.network's design tokens.
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        espresso: {
          orange: '#ff792e',
          cream: '#fff7ef',
          milk: '#fcebde',
          beige: '#f8e5d4',
          latte: '#de9e67',
          brown: '#b67237',
          roast: '#915b2c',
          dark: '#451f17',
          bean: '#270903',
          black: '#130401',
        },
        ok: '#16a34a',
        warn: '#d97706',
        crit: '#dc2626',
      },
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
