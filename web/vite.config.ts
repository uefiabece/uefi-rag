import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Caminhos relativos: o mesmo build serve em localhost e em <usuário>.github.io/ufabc-rag/.
  base: "./",
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
