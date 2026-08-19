/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A restrained clinical palette. Slate carries the interface; a single
        // teal accent marks interactive and primary elements. Status colours are
        // reserved strictly for stock and insight severity, so colour always
        // means something rather than decorating.
        brand: {
          50: '#eef9f8', 100: '#d3f0ee', 200: '#a9e2df', 300: '#72cdc9',
          400: '#41b0ad', 500: '#279492', 600: '#1d7676', 700: '#1b5f5f',
          800: '#1a4c4d', 900: '#194041', 950: '#082526',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 10px 30px -10px rgb(15 23 42 / 0.25)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'fade-in': 'fade-in .25s ease-out both' },
    },
  },
  plugins: [],
};
