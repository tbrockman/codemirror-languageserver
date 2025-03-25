import { describe, it, expect } from "vitest";
import { prefixMatch } from "./utils";
import type * as LSP from "vscode-languageserver-protocol";

describe("prefixMatch", () => {
    it("should handle empty items array", () => {
        const [startMatch, anywhereMatch] = prefixMatch([]);
        expect(startMatch.test("")).toBe(false);
        expect(anywhereMatch.test("")).toBe(false);
    });

    it("should match single character prefixes", () => {
        const items: LSP.CompletionItem[] = [
            { label: "a" },
            { label: "b" },
            { label: "c" },
        ];
        const [startMatch, anywhereMatch] = prefixMatch(items);

        expect(startMatch.test("a")).toBe(true);
        expect(startMatch.test("b")).toBe(true);
        expect(startMatch.test("c")).toBe(true);
        expect(startMatch.test("d")).toBe(true);

        expect(anywhereMatch.test("xa")).toBe(true);
        expect(anywhereMatch.test("xb")).toBe(true);
        expect(anywhereMatch.test("xc")).toBe(true);
        expect(anywhereMatch.test("xd")).toBe(true);
    });

    it("should handle textEdit items", () => {
        const items: LSP.CompletionItem[] = [
            { textEdit: { newText: "function" } },
            { textEdit: { newText: "for" } },
        ];
        const [startMatch] = prefixMatch(items);

        expect(startMatch.test("f")).toBe(true);
        expect(startMatch.test("fu")).toBe(true);
        expect(startMatch.test("fo")).toBe(true);
        expect(startMatch.test("g")).toBe(true);
    });

    it("should handle mixed word and non-word characters", () => {
        const items: LSP.CompletionItem[] = [
            { label: "user.name" },
            { label: "user.email" },
        ];
        const [startMatch, anywhereMatch] = prefixMatch(items);

        expect(startMatch.test("user")).toBe(true);
        expect(startMatch.test("user.")).toBe(true);
        expect(startMatch.test("user.n")).toBe(true);
        expect(startMatch.test("user@")).toBe(false);
    });

    it("should handle special characters", () => {
        const items: LSP.CompletionItem[] = [
            { label: "$name" },
            { label: "$value" },
        ];
        const [startMatch, anywhereMatch] = prefixMatch(items);

        expect(startMatch.test("$")).toBe(true);
        expect(startMatch.test("$n")).toBe(true);
        expect(startMatch.test("$v")).toBe(true);
        expect(startMatch.test("#")).toBe(false);
    });
});
