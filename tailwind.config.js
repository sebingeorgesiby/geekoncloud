/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
        display: ['Syne', 'sans-serif'],
      },
      colors: {
        cloud: {
          50:  '#f0f7ff',
          100: '#e0efff',
          200: '#b9daff',
          300: '#7cbaff',
          400: '#3694ff',
          500: '#0a70f5',
          600: '#0052d4',
          700: '#003faa',
          800: '#00348c',
          900: '#002a70',
        },
        ink: {
          50:  '#f4f4f5',
          100: '#e4e4e7',
          200: '#d4d4d8',
          300: '#a1a1aa',
          400: '#71717a',
          500: '#52525b',
          600: '#3f3f46',
          700: '#27272a',
          800: '#18181b',
          900: '#09090b',
        }
      },
      typography: {
        DEFAULT: {
          css: {
            color: '#18181b',
            a: { color: '#0052d4', '&:hover': { color: '#0a70f5' } },
            'h1,h2,h3,h4': { fontFamily: 'Syne, sans-serif', fontWeight: '700' },
            code: { fontFamily: 'IBM Plex Mono, monospace', fontSize: '0.875em', background: '#f4f4f5', padding: '0.15em 0.35em', borderRadius: '3px' },
            pre: { background: '#09090b', color: '#e4e4e7' },
          }
        }
      }
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
