import type { EditorView } from "@codemirror/view";
import type { Completion } from "@codemirror/autocomplete";
import type * as LSP from "vscode-languageserver-protocol";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import { insertCompletionText } from "@codemirror/autocomplete";
import {
    formatContents,
    isEmptyDocumentation,
    isLSPTextEdit,
    posToOffset,
    posToOffsetOrZero,
} from "./utils.js";

const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

interface ConvertCompletionOptions {
    allowHTMLContent: boolean;
    hasResolveProvider: boolean;
    resolveItem: (item: LSP.CompletionItem) => Promise<LSP.CompletionItem>;
}

/**
 * Converts an LSP completion item to a CodeMirror completion item
 */
export function convertCompletionItem(
    item: LSP.CompletionItem,
    options: ConvertCompletionOptions,
): Completion {
    const {
        detail,
        labelDetails,
        label,
        kind,
        textEdit,
        insertText,
        documentation,
        additionalTextEdits,
    } = item;

    const completion: Completion = {
        label,
        detail: labelDetails?.detail || detail,
        apply(
            view: EditorView,
            _completion: Completion,
            from: number,
            to: number,
        ) {
            if (textEdit && isLSPTextEdit(textEdit)) {
                view.dispatch(
                    insertCompletionText(
                        view.state,
                        textEdit.newText,
                        posToOffsetOrZero(view.state.doc, textEdit.range.start),
                        posToOffsetOrZero(view.state.doc, textEdit.range.end),
                    ),
                );
            } else {
                view.dispatch(
                    insertCompletionText(
                        view.state,
                        insertText || label,
                        from,
                        to,
                    ),
                );
            }
            if (!additionalTextEdits) {
                return;
            }
            const sortedEdits = additionalTextEdits.sort(
                ({ range: { end: a } }, { range: { end: b } }) => {
                    if (
                        posToOffsetOrZero(view.state.doc, a) <
                        posToOffsetOrZero(view.state.doc, b)
                    ) {
                        return 1;
                    }
                    if (
                        posToOffsetOrZero(view.state.doc, a) >
                        posToOffsetOrZero(view.state.doc, b)
                    ) {
                        return -1;
                    }
                    return 0;
                },
            );
            for (const textEdit of sortedEdits) {
                view.dispatch(
                    view.state.update({
                        changes: {
                            from: posToOffsetOrZero(
                                view.state.doc,
                                textEdit.range.start,
                            ),
                            to: posToOffset(view.state.doc, textEdit.range.end),
                            insert: textEdit.newText,
                        },
                    }),
                );
            }
        },
        type: kind && CompletionItemKindMap[kind].toLowerCase(),
    };

    // Support lazy loading of documentation through completionItem/resolve
    if (options.hasResolveProvider && options.resolveItem) {
        completion.info = async () => {
            try {
                const resolved = await options.resolveItem?.(item);
                const dom = document.createElement("div");
                dom.classList.add("documentation");
                const content = resolved?.documentation || documentation;
                if (!content) {
                    return null;
                }
                if (isEmptyDocumentation(content)) {
                    return null;
                }
                if (options.allowHTMLContent) {
                    dom.innerHTML = formatContents(content);
                } else {
                    dom.textContent = formatContents(content);
                }
                return dom;
            } catch (e) {
                console.error("Failed to resolve completion item:", e);
                if (isEmptyDocumentation(documentation)) {
                    return null;
                }
                // Fallback to existing documentation if resolve fails
                if (documentation) {
                    const dom = document.createElement("div");
                    dom.classList.add("documentation");
                    if (options.allowHTMLContent) {
                        dom.innerHTML = formatContents(documentation);
                    } else {
                        dom.textContent = formatContents(documentation);
                    }
                    return dom;
                }
                return null;
            }
        };
    } else if (documentation) {
        // Fallback for servers without resolve support
        completion.info = () => {
            const dom = document.createElement("div");
            dom.classList.add("documentation");
            if (options.allowHTMLContent) {
                dom.innerHTML = formatContents(documentation);
            } else {
                dom.textContent = formatContents(documentation);
            }
            return dom;
        };
    }

    return completion;
}
