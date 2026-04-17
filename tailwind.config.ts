import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-dm-sans)", "DM Sans", "sans-serif"],
        serif: ["var(--font-fraunces)", "Fraunces", "serif"],
      },
      colors: {
        brand: {
          teal: "#2BB5B2",
          tealDark: "#229E9B",
          tealLight: "#E8F7F7",
          tealFaint: "#E6F6F5",
          red: "#f84455",
          redHover: "#e63344",
          ink: "#1F2933",
          dark: "#1a1a2e",
          darkMid: "#2d2d44",
          mist: "#F2F2F2",
          grey600: "#555",
          grey400: "#999",
          grey200: "#e0e0e0",
        },
      },
      borderRadius: {
        card: "16px",
        input: "10px",
      },
      boxShadow: {
        card: "0 4px 24px rgba(0,0,0,.06)",
        cardLg: "0 12px 48px rgba(0,0,0,.1)",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(24px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(0.85)" },
        },
        scanMove: {
          "0%": { left: "-100%" },
          "100%": { left: "200%" },
        },
        confirmPop: {
          from: { transform: "scale(0)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        spinSlow: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.6s ease forwards",
        pulse: "pulse 1.5s ease infinite",
        "scan-move": "scanMove 2s ease infinite",
        "confirm-pop": "confirmPop 0.5s cubic-bezier(.34,1.56,.64,1) forwards",
        "spin-slow": "spinSlow 4s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
