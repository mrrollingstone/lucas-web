import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          teal: "#2BB5B2",
          tealDark: "#1F8B88",
          tealFaint: "#E6F6F5",
          red: "#F84455",
          ink: "#1F2933",
          mist: "#F2F2F2",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
