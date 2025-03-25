import type { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { CompletionTriggerKind } from "vscode-languageserver-protocol";
import { getCompletionTriggerKind } from "../plugin";

describe("getCompletionTriggerKind", () => {
    // Setup a test document with some content
    const createMockDocument = (content: string) => {
        return EditorState.create({ doc: content });
    };

    // Create mock CompletionContext
    const createMockContext = ({
        state,
        pos,
        explicit = false,
        matchBefore = vi.fn().mockReturnValue(false),
    }: {
        state: EditorState;
        pos: number;
        explicit?: boolean;
        matchBefore?: (regexp: RegExp) => boolean | null;
    }): CompletionContext => {
        return {
            state,
            pos,
            explicit,
            matchBefore,
            aborted: false,
            tokenBefore: null,
            tokenAfter: null,
        } as unknown as CompletionContext;
    };

    it("should return TriggerCharacter for trigger character", () => {
        // Setup document with a trigger character
        const doc = createMockDocument("hello.");
        const pos = 6; // Position right after the dot
        const context = createMockContext({ state: doc, pos });

        // Setup the matchBefore function to mimic real behavior
        context.matchBefore = vi
            .fn()
            .mockReturnValue({ from: 5, to: 6, text: "." });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ".",
        });
    });

    it("should return Invoked for manual completion", () => {
        // Setup document with non-trigger text
        const doc = createMockDocument("hello");
        const pos = 5; // Position at the end of the word
        const context = createMockContext({
            state: doc,
            pos,
            explicit: true,
            matchBefore: vi
                .fn()
                .mockReturnValue({ from: 0, to: 5, text: "hello" }),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should return null for non-word characters with Invoked trigger", () => {
        // Setup document with a character that doesn't qualify for completion
        const doc = createMockDocument("hello!");
        const pos = 6; // Position after the exclamation mark
        const context = createMockContext({
            state: doc,
            pos,
            // This mock mimics the behavior when there's no match for word, dot, or slash
            matchBefore: vi.fn().mockReturnValue(null),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toBeNull();
    });

    it("should return Invoked for word character at cursor position", () => {
        // Setup document with a word
        const doc = createMockDocument("test");
        const pos = 4; // End of the word
        const context = createMockContext({
            state: doc,
            pos,
            // This mock simulates matching a word
            matchBefore: vi
                .fn()
                .mockReturnValue({ from: 0, to: 4, text: "test" }),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle triggers for slash character", () => {
        // Setup document with a slash
        const doc = createMockDocument("path/");
        const pos = 5; // Position after the slash
        const context = createMockContext({
            state: doc,
            pos,
            matchBefore: vi.fn().mockReturnValue({ from: 4, to: 5, text: "/" }),
        });

        // Include slash as a trigger character
        const result = getCompletionTriggerKind(context, [".", "/"]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: "/",
        });
    });

    it("should handle multiple characters in a word", () => {
        // Setup document with a word in progress
        const doc = createMockDocument("testin");
        const pos = 6; // In the middle of typing "testing"
        const context = createMockContext({
            state: doc,
            pos,
            matchBefore: vi
                .fn()
                .mockReturnValue({ from: 0, to: 6, text: "testin" }),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should handle object property access", () => {
        // Setup document with object property access
        const doc = createMockDocument("obj.prop");
        const pos = 8; // At the end of "obj.prop"
        const context = createMockContext({
            state: doc,
            pos,
            matchBefore: vi
                .fn()
                .mockReturnValue({ from: 4, to: 8, text: "prop" }),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.Invoked,
            triggerCharacter: undefined,
        });
    });

    it("should return TriggerCharacter right after typing a trigger", () => {
        // Setup document with a trigger character just typed
        const doc = createMockDocument("console.");
        const pos = 8; // Right after the dot

        // Simulate that "." was just typed (not explicit, matchBefore would return the dot)
        const context = createMockContext({
            state: doc,
            pos,
            explicit: false,
            matchBefore: vi.fn().mockReturnValue({ from: 7, to: 8, text: "." }),
        });

        const result = getCompletionTriggerKind(context, ["."]);

        expect(result).toEqual({
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: ".",
        });
    });
});
