import { describe, expect, it } from "vitest";
import type * as LSP from "vscode-languageserver-protocol";
import { isEmptyDocumentation } from "../utils";

describe("isEmptyDocumentation", () => {
    it("should return true for null or undefined documentation", () => {
        expect(isEmptyDocumentation(null)).toBe(true);
        expect(isEmptyDocumentation(undefined)).toBe(true);
    });

    it("should return true for empty string documentation", () => {
        expect(isEmptyDocumentation("")).toBe(true);
    });

    it("should return true for whitespace-only string documentation", () => {
        expect(isEmptyDocumentation("   ")).toBe(true);
        expect(isEmptyDocumentation("\n\t  ")).toBe(true);
    });

    it("should return true for string with only backticks", () => {
        expect(isEmptyDocumentation("```")).toBe(true);
        expect(isEmptyDocumentation("` ` `")).toBe(true);
    });

    it("should return false for non-empty string documentation", () => {
        expect(isEmptyDocumentation("Hello")).toBe(false);
        expect(isEmptyDocumentation("  Hello  ")).toBe(false);
    });

    it("should return true for empty array documentation", () => {
        expect(isEmptyDocumentation([])).toBe(true);
    });

    it("should return true for array with empty items", () => {
        expect(isEmptyDocumentation(["", "   ", "```"])).toBe(true);
    });

    it("should return false for array with at least one non-empty item", () => {
        expect(isEmptyDocumentation(["", "Hello", ""])).toBe(false);
    });

    it("should return true for MarkupContent with empty value", () => {
        const markupContent: LSP.MarkupContent = {
            kind: "plaintext",
            value: "",
        };
        expect(isEmptyDocumentation(markupContent)).toBe(true);
    });

    it("should return true for MarkupContent with whitespace-only value", () => {
        const markupContent: LSP.MarkupContent = {
            kind: "plaintext",
            value: "   \n  ",
        };
        expect(isEmptyDocumentation(markupContent)).toBe(true);
    });

    it("should return true for MarkupContent with only backticks", () => {
        const markupContent: LSP.MarkupContent = {
            kind: "markdown",
            value: "```",
        };
        expect(isEmptyDocumentation(markupContent)).toBe(true);
    });

    it("should return false for MarkupContent with non-empty value", () => {
        const markupContent: LSP.MarkupContent = {
            kind: "markdown",
            value: "# Hello",
        };
        expect(isEmptyDocumentation(markupContent)).toBe(false);
    });

    it("should return false for MarkedString with non-empty content", () => {
        const markedString: LSP.MarkedString = {
            language: "typescript",
            value: "const x = 5;",
        };
        expect(isEmptyDocumentation(markedString)).toBe(false);
    });

    it("should handle mixed array of MarkedString and string correctly", () => {
        const mixedArray: LSP.MarkedString[] = [
            "",
            {
                language: "typescript",
                value: "const x = 5;",
            },
        ];
        expect(isEmptyDocumentation(mixedArray)).toBe(false);
    });

    it("should return true for array of all empty items", () => {
        const allEmptyArray: LSP.MarkedString[] = [
            "",
            "   ",
            {
                language: "typescript",
                value: "",
            },
            {
                language: "markdown",
                value: "```",
            },
        ];
        expect(isEmptyDocumentation(allEmptyArray)).toBe(true);
    });
});
