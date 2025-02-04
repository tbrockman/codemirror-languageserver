import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
    base: "/codemirror-languageserver/",
});
