import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        mist: "#f5f1e8",
        sand: "#e8dcc5",
        ember: "#e95f38",
        pine: "#124c41",
      },
      boxShadow: {
        panel: "0 18px 60px rgba(17, 17, 17, 0.08)",
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        body: ["ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
