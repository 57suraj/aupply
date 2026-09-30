/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        accent: "#FF4D00",
        "accent-hover": "#E84500",
        "accent-muted": "rgba(255, 77, 0, 0.15)",
        ink: "#09090b",
        paper: "#F9F8F5",
        surface: {
          DEFAULT: "#0f0f12",
          elevated: "#18181c",
          overlay: "#222227",
          border: "rgba(255, 255, 255, 0.09)",
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', "system-ui", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      fontSize: {
        "display-xl": ["clamp(3.5rem,9vw,8rem)", { lineHeight: "0.94", letterSpacing: "-0.035em" }],
        "display-lg": ["clamp(2.25rem,6vw,5rem)", { lineHeight: "0.98", letterSpacing: "-0.025em" }],
        "display-md": ["clamp(1.5rem,3.5vw,2.75rem)", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
      },
      boxShadow: {
        "glow-accent": "0 0 24px -2px rgba(255, 77, 0, 0.35)",
        "glow-accent-lg": "0 0 40px -4px rgba(255, 77, 0, 0.45)",
        "glow-white": "0 0 24px -2px rgba(255, 255, 255, 0.18)",
        "surface": "0 1px 3px 0 rgba(0, 0, 0, 0.4), 0 1px 2px -1px rgba(0, 0, 0, 0.4)",
      },
    },
  },
  plugins: [],
};
