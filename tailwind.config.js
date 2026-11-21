/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/index.html', './web/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        ink: '#0d100c',
        parchment: '#e9dfc9',
        gold: '#d9ac5b',
        blood: '#a73b36',
      },
      fontFamily: {
        display: ['Cinzel', 'serif'],
        body: ['Nunito', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
