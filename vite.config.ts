import { defineConfig } from "vite";

export default defineConfig({
    root: process.env.VITEST ? "." : "demo",
    test: {
        globals: true,
        environment: "jsdom",
    },
    base: "/codemirror-languageserver/",
});
