/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ base: "/statement-to-dashboard/", plugins: [react()], test: { include: ["tests/**/*.test.ts"] } });
