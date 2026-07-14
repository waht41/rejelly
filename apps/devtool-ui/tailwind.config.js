/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
        // Semantic colors for interactive elements
        "resize-handle-hover": "hsl(var(--resize-handle-hover))",
        "tree-item-hover": "hsl(var(--tree-item-hover))",
        "tree-item-hover-text": "hsl(var(--tree-item-hover-text))",
        "tree-item-selected": "hsl(var(--tree-item-selected))",
        "tree-item-selected-text": "hsl(var(--tree-item-selected-text))",
        "tree-item-text": "hsl(var(--tree-item-text))",
        "tree-item-icon-hover": "hsl(var(--tree-item-icon-hover))",
        "tree-item-icon-agent": "hsl(var(--tree-item-icon-agent))",
        "tree-item-icon-span": "hsl(var(--tree-item-icon-span))",
        "card-bg": "hsl(var(--card-bg))",
        "ring-offset": "hsl(var(--ring-offset))",
        "badge-bg": "hsl(var(--badge-bg))",
        "badge-text": "hsl(var(--badge-text))",
        "badge-border": "hsl(var(--badge-border))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "Monaco", "monospace"],
      },
      keyframes: {
        progress: {
          "0%": { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
      },
      animation: {
        progress: "progress 1s ease-out",
      },
    },
  },
  plugins: [],
};
