import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "konva",
              test: /node_modules[\\/](?:konva|react-konva)[\\/]/
            },
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/
            }
          ]
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 3230,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 3231,
    strictPort: true
  }
});
