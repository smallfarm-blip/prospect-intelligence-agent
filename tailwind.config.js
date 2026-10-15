/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f7f7f5', 100: '#efeeea', 200: '#dddbd3', 300: '#c3c0b4', 400: '#9a968a',
          500: '#76726a', 600: '#5b5852', 700: '#45433f', 800: '#2d2c29', 900: '#1b1a18',
        },
        primary: {
          50: '#effaf8', 100: '#d4f1ec', 200: '#a9e2d9', 300: '#74ccc0', 400: '#45afa3',
          500: '#2b9389', 600: '#1f766f', 700: '#1c5f5a', 800: '#1a4c49', 900: '#173f3d',
        },
        secondary: {
          50: '#f2f6fb', 100: '#e1e9f5', 200: '#c4d4eb', 300: '#9ab5dc', 400: '#6a8fc8',
          500: '#4a70b3', 600: '#3a5897', 700: '#31477b', 800: '#2c3d66', 900: '#283555',
        },
        accent: {
          50: '#fdf6ee', 100: '#f9e8d4', 200: '#f2cfa6', 300: '#e9af72', 400: '#e08d47',
          500: '#d6722b', 600: '#bc5a21', 700: '#9c441e', 800: '#7e381f', 900: '#672f1c',
        },
        success: { 50: '#effbf3', 100: '#d8f4e1', 200: '#b3e8c6', 500: '#2f9e5b', 600: '#22804a', 700: '#1d653d' },
        warning: { 50: '#fffaeb', 100: '#fdefc7', 200: '#fbdd8a', 500: '#d99a0b', 600: '#b97806', 700: '#935709' },
        error: { 50: '#fdf3f3', 100: '#fbe4e4', 200: '#f6cbcb', 500: '#d14343', 600: '#b52f2f', 700: '#932828' },
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'slide-in': { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } },
      },
      animation: {
        'fade-up': 'fade-up 240ms ease-out both',
        'slide-in': 'slide-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
      },
    },
  },
  plugins: [],
};
