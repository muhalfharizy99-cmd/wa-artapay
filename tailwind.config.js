/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.html",
    "./public/**/*.js",
    "./src/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        surface: { 
          900: '#0f1117', 
          800: '#161b22', 
          700: '#1c2333', 
          600: '#21262d', 
          500: '#30363d' 
        },
      },
      fontFamily: { 
        sans: ['Inter', 'system-ui', 'sans-serif'] 
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'slide-in':   'slideIn 0.3s ease-out',
        'fade-in':    'fadeIn 0.4s ease-out',
      },
      keyframes: {
        slideIn: { 
          from: { transform: 'translateY(-10px)', opacity: '0' }, 
          to: { transform: 'translateY(0)', opacity: '1' } 
        },
        fadeIn:  { 
          from: { opacity: '0' }, 
          to: { opacity: '1' } 
        },
      }
    }
  },
  plugins: [],
  darkMode: 'class',
}
