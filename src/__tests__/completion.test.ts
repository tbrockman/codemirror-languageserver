import { describe, it, expect, vi } from "vitest";
import { convertCompletionItem } from "../completion.js";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";

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
