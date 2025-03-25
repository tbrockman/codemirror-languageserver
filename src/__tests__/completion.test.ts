import { describe, it, expect, vi } from "vitest";
import { convertCompletionItem } from "../completion.js";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import { sortCompletionItems } from "../completion.js";

describe("convertCompletionItem", () => {
    it("should convert a basic completion item", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            kind: CompletionItemKind.Text,
            detail: "Test detail",
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion).toEqual({
            label: "test",
            detail: "Test detail",
            type: "text",
            apply: expect.any(Function),
        });
    });

    it("should handle textEdit", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            textEdit: {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 4 },
                },
                newText: "test",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
        // Note: We can't easily test the apply function here since it requires a view
    });

    it("should handle documentation with HTML content", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "<strong>Test</strong> documentation",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: true,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = completion.info?.();
        expect(info).toBeDefined();
        expect(info?.classList.contains("documentation")).toBe(true);
        expect(info?.innerHTML).toContain(
            "<strong>Test</strong> documentation",
        );
    });

    it("should handle documentation without HTML content", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "**Test** documentation",
            },
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = completion.info?.();
        expect(info).toBeDefined();
        expect(info?.classList.contains("documentation")).toBe(true);
        expect(info?.textContent).toContain(
            "<strong>Test</strong> documentation",
        );
    });

    it("should handle completion item resolution", async () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "Initial documentation",
            },
        };

        const resolvedItem: LSP.CompletionItem = {
            ...lspItem,
            documentation: {
                kind: "markdown",
                value: "Resolved documentation",
            },
        };

        const resolveItem = vi.fn().mockResolvedValue(resolvedItem);

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: true,
            resolveItem,
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = await completion.info?.();
        expect(info).toBeDefined();
        expect(info?.textContent).toContain("Resolved documentation");
        expect(resolveItem).toHaveBeenCalledWith(lspItem);
    });

    it("should handle resolution failure gracefully", async () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            documentation: {
                kind: "markdown",
                value: "Initial documentation",
            },
        };

        const resolveItem = vi
            .fn()
            .mockRejectedValue(new Error("Resolution failed"));

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: true,
            resolveItem,
        });

        expect(completion.info).toBeDefined();
        // @ts-expect-error - info is a function
        const info = await completion.info?.();
        expect(info).toBeDefined();
        expect(info?.textContent).toContain("Initial documentation");
    });

    it("should handle additional text edits", () => {
        const lspItem: LSP.CompletionItem = {
            label: "test",
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 4 },
                    },
                    newText: "test",
                },
            ],
        };

        const completion = convertCompletionItem(lspItem, {
            allowHTMLContent: false,
            hasResolveProvider: false,
            resolveItem: vi.fn(),
        });

        expect(completion.apply).toBeDefined();
    });
});

describe("sortCompletionItems", () => {
    const createItem = (
        label: string,
        sortText?: string,
    ): LSP.CompletionItem => ({
        label,
        sortText,
    });

    it("should sort by prefix match when matchBefore is provided", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
            createItem("testing"),
        ];

        const filtered = sortCompletionItems(items, "te", "javascript");
        expect(filtered.map((i) => i.label)).toEqual(["test", "testing"]);

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual([
            "alpha",
            "test",
            "testing",
            "zebra",
        ]);
    });

    it("should use sortText over label when available", () => {
        const items = [
            createItem("zebra", "1"),
            createItem("alpha", "2"),
            createItem("test", "0"),
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["test", "zebra", "alpha"]);
    });

    it("should filter out non-matching items for word characters", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
            createItem("testing"),
        ];

        const sorted = sortCompletionItems(items, "al", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha"]);
    });

    it("should not filter for non-word characters", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
        ];

        const sorted = sortCompletionItems(items, "@", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "test", "zebra"]);
    });

    it("should prioritize Python assignments", () => {
        const items = [
            createItem("value"),
            createItem("name="),
            createItem("test"),
            createItem("id="),
        ];

        const sorted = sortCompletionItems(items, undefined, "python");
        expect(sorted.map((i) => i.label)).toEqual([
            "id=",
            "name=",
            "test",
            "value",
        ]);
    });

    it("should handle filterText in prefix matching", () => {
        const items = [
            { label: "display", filterText: "_display" },
            { label: "test", filterText: "_test" },
            { label: "alpha", filterText: "_alpha" },
        ];

        const sorted = sortCompletionItems(items, "_t", "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["test"]);
    });

    it("should handle empty matchBefore", () => {
        const items = [
            createItem("zebra"),
            createItem("alpha"),
            createItem("test"),
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "test", "zebra"]);
    });

    it("should handle case insensitive matching", () => {
        const items = [
            createItem("Zebra"),
            createItem("alpha"),
            createItem("Test"),
        ];

        const filtered = sortCompletionItems(items, "te", "javascript");
        expect(filtered.map((i) => i.label)).toEqual(["Test"]);

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual(["alpha", "Test", "Zebra"]);
    });

    it("should sort underscores last", () => {
        const items = [
            { label: "alpha", sortText: "alpha" },
            { label: "_hidden", sortText: "z_hidden" },
            { label: "beta", sortText: "beta" },
            { label: "__private", sortText: "zz__private" },
            { label: "gamma", sortText: "gamma" },
        ];

        const sorted = sortCompletionItems(items, undefined, "javascript");
        expect(sorted.map((i) => i.label)).toEqual([
            "alpha",
            "beta",
            "gamma",
            "_hidden",
            "__private",
        ]);
    });
});
