import { EditorView, PluginValue, Tooltip, ViewUpdate } from "@codemirror/view";
import type { DefinitionResult, LanguageServerClient, Notification } from "../lsp/types.js";
import { Completion, CompletionContext, CompletionResult, insertCompletionText } from "@codemirror/autocomplete";
import { CompletionItemKind, CompletionTriggerKind, DiagnosticSeverity, PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import type LSP from 'vscode-languageserver-protocol';
import { formatContents, isLSPTextEdit, posToOffset, posToOffsetOrZero, prefixMatch, showErrorMessage } from "../utils/index.js";
import { Action, Diagnostic, setDiagnostics } from "@codemirror/lint";

const changesDelay = 500;
const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;
const logger = console.log;

export class LanguageServerPlugin implements PluginValue {
    private documentVersion: number;
    private changesTimeout: number;
    private onGoToDefinition?: (result: DefinitionResult) => void;

    constructor(
        public client: LanguageServerClient,
        private documentUri: string,
        private languageId: string,
        private view: EditorView,
        private allowHTMLContent = false,
        onGoToDefinition?: (result: DefinitionResult) => void,
    ) {
        this.documentVersion = 0;
        this.changesTimeout = 0;
        this.onGoToDefinition = onGoToDefinition;

        this.client.attachPlugin(this);

        this.initialize({
            documentText: this.view.state.doc.toString(),
        });
    }

    public update({ docChanged }: ViewUpdate) {
        if (!docChanged) {
            return;
        }
        if (this.changesTimeout) {
            clearTimeout(this.changesTimeout);
        }
        this.changesTimeout = self.setTimeout(() => {
            this.sendChange({
                documentText: this.view.state.doc.toString(),
            });
        }, changesDelay);
    }

    public destroy() {
        this.client.detachPlugin(this);
    }

    public async initialize({ documentText }: { documentText: string }) {
        if (this.client.initializePromise) {
            await this.client.initializePromise;
        }
        this.client.textDocumentDidOpen({
            textDocument: {
                uri: this.documentUri,
                languageId: this.languageId,
                text: documentText,
                version: this.documentVersion,
            },
        });
    }

    public async sendChange({ documentText }: { documentText: string }) {
        if (!this.client.ready) {
            return;
        }
        try {
            await this.client.textDocumentDidChange({
                textDocument: {
                    uri: this.documentUri,
                    version: this.documentVersion++,
                },
                contentChanges: [{ text: documentText }],
            });
        } catch (e) {
            console.error(e);
        }
    }

    public requestDiagnostics(view: EditorView) {
        this.sendChange({ documentText: view.state.doc.toString() });
    }

    public async requestHoverTooltip(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): Promise<Tooltip | null> {
        if (!(this.client.ready && this.client.capabilities?.hoverProvider)) {
            return null;
        }

        this.sendChange({ documentText: view.state.doc.toString() });
        const result = await this.client.textDocumentHover({
            textDocument: { uri: this.documentUri },
            position: { line, character },
        });
        if (!result) {
            return null;
        }
        const { contents, range } = result;
        let pos = posToOffset(view.state.doc, { line, character });
        let end: number | undefined;
        if (range) {
            pos = posToOffset(view.state.doc, range.start);
            end = posToOffset(view.state.doc, range.end);
        }
        if (pos == null) {
            return null;
        }
        const dom = document.createElement("div");
        dom.classList.add("documentation");
        if (this.allowHTMLContent) {
            dom.innerHTML = formatContents(contents);
        } else {
            dom.textContent = formatContents(contents);
        }
        return {
            pos,
            end,
            create: (_view) => ({ dom }),
            above: true,
        };
    }

    public async requestCompletion(
        context: CompletionContext,
        { line, character }: { line: number; character: number },
        {
            triggerKind,
            triggerCharacter,
        }: {
            triggerKind: CompletionTriggerKind;
            triggerCharacter: string | undefined;
        },
    ): Promise<CompletionResult | null> {
        if (
            !(this.client.ready && this.client.capabilities?.completionProvider)
        ) {
            return null;
        }
        this.sendChange({
            documentText: context.state.doc.toString(),
        });

        const result = await this.client.textDocumentCompletion({
            textDocument: { uri: this.documentUri },
            position: { line, character },
            context: {
                triggerKind,
                triggerCharacter,
            },
        });

        if (!result) {
            return null;
        }

        let items = "items" in result ? result.items : result;

        const [_span, match] = prefixMatch(items);
        if (!match) {
            return null;
        }
        const token = context.matchBefore(match);
        let { pos } = context;

        if (token) {
            pos = token.from;
            const word = token.text.toLowerCase();
            if (/^\w+$/.test(word)) {
                items = items
                    .filter(({ label, filterText }) => {
                        const text = filterText ?? label;
                        return text.toLowerCase().startsWith(word);
                    })
                    .sort((a, b) => {
                        const aText = a.sortText ?? a.label;
                        const bText = b.sortText ?? b.label;
                        switch (true) {
                            case aText.startsWith(token.text) &&
                                !bText.startsWith(token.text):
                                return -1;
                            case !aText.startsWith(token.text) &&
                                bText.startsWith(token.text):
                                return 1;
                        }
                        return 0;
                    });
            }
        }

        const options = items.map((item) => {
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
                                posToOffsetOrZero(
                                    view.state.doc,
                                    textEdit.range.start,
                                ),
                                posToOffsetOrZero(
                                    view.state.doc,
                                    textEdit.range.end,
                                ),
                            ),
                        );
                    } else {
                        view.dispatch(
                            insertCompletionText(
                                view.state,
                                // Prefer insertText, otherwise fallback to label
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
                                    to: posToOffset(
                                        view.state.doc,
                                        textEdit.range.end,
                                    ),
                                    insert: textEdit.newText,
                                },
                            }),
                        );
                    }
                },
                type: kind && CompletionItemKindMap[kind].toLowerCase(),
            };

            // Support lazy loading of documentation through completionItem/resolve
            if (this.client.capabilities?.completionProvider?.resolveProvider) {
                completion.info = async () => {
                    try {
                        const resolved =
                            await this.client.completionItemResolve(item);
                        const dom = document.createElement("div");
                        dom.classList.add("documentation");
                        const content = resolved.documentation || documentation;
                        if (this.allowHTMLContent) {
                            dom.innerHTML = formatContents(content);
                        } else {
                            dom.textContent = formatContents(content);
                        }
                        return dom;
                    } catch (e) {
                        console.error("Failed to resolve completion item:", e);
                        // Fallback to existing documentation if resolve fails
                        if (documentation) {
                            const dom = document.createElement("div");
                            dom.classList.add("documentation");
                            if (this.allowHTMLContent) {
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
                    if (this.allowHTMLContent) {
                        dom.innerHTML = formatContents(documentation);
                    } else {
                        dom.textContent = formatContents(documentation);
                    }
                    return dom;
                };
            }
            return completion;
        });

        return {
            from: pos,
            options,
            filter: false,
        };
    }

    public async requestDefinition(
        _view: EditorView,
        { line, character }: { line: number; character: number },
    ) {
        if (
            !(this.client.ready && this.client.capabilities?.definitionProvider)
        ) {
            return;
        }

        const result = await this.client.textDocumentDefinition({
            textDocument: { uri: this.documentUri },
            position: { line, character },
        });

        if (!result) return;

        const locations = Array.isArray(result) ? result : [result];
        if (locations.length === 0) return;

        // For now just handle the first location
        const location = locations[0];
        if (!location) return;
        const uri = "uri" in location ? location.uri : location.targetUri;
        const range =
            "range" in location ? location.range : location.targetRange;

        // Check if the definition is in a different document
        const isExternalDocument = uri !== this.documentUri;

        // Create the definition result
        const definitionResult: DefinitionResult = {
            uri,
            range,
            isExternalDocument,
        };

        // If it's the same document, update the selection
        if (!isExternalDocument) {
            this.view.dispatch(
                this.view.state.update({
                    selection: {
                        anchor: posToOffsetOrZero(
                            this.view.state.doc,
                            range.start,
                        ),
                        head: posToOffset(this.view.state.doc, range.end),
                    },
                }),
            );
        }

        if (this.onGoToDefinition) {
            this.onGoToDefinition(definitionResult);
        }

        return definitionResult;
    }

    public processNotification(notification: Notification) {
        try {
            switch (notification.method) {
                case "textDocument/publishDiagnostics":
                    this.processDiagnostics(notification.params);
            }
        } catch (error) {
            logger(error);
        }
    }

    public async processDiagnostics(params: PublishDiagnosticsParams) {
        if (params.uri !== this.documentUri) {
            return;
        }

        const severityMap: Record<DiagnosticSeverity, Diagnostic["severity"]> =
        {
            [DiagnosticSeverity.Error]: "error",
            [DiagnosticSeverity.Warning]: "warning",
            [DiagnosticSeverity.Information]: "info",
            [DiagnosticSeverity.Hint]: "info",
        };

        const diagnostics = params.diagnostics.map(
            async ({ range, message, severity, code }) => {
                const actions = await this.requestCodeActions(range, [
                    code as string,
                ]);

                const codemirrorActions = actions?.map(
                    (action): Action => ({
                        name:
                            "command" in action &&
                                typeof action.command === "object"
                                ? action.command?.title || action.title
                                : action.title,
                        apply: async () => {
                            if ("edit" in action && action.edit?.changes) {
                                const changes =
                                    action.edit.changes[this.documentUri];

                                if (!changes) {
                                    return;
                                }

                                // Apply workspace edit
                                for (const change of changes) {
                                    this.view.dispatch(
                                        this.view.state.update({
                                            changes: {
                                                from: posToOffsetOrZero(
                                                    this.view.state.doc,
                                                    change.range.start,
                                                ),
                                                to: posToOffset(
                                                    this.view.state.doc,
                                                    change.range.end,
                                                ),
                                                insert: change.newText,
                                            },
                                        }),
                                    );
                                }
                            }

                            if ("command" in action && action.command) {
                                // TODO: Implement command execution
                                // Execute command if present
                                logger("Executing command:", action.command);
                            }
                        },
                    }),
                );

                const diagnostic: Diagnostic = {
                    from: posToOffsetOrZero(this.view.state.doc, range.start),
                    to: posToOffsetOrZero(this.view.state.doc, range.end),
                    severity: severityMap[severity ?? DiagnosticSeverity.Error],
                    message: message,
                    source: this.languageId,
                    actions: codemirrorActions,
                };

                return diagnostic;
            },
        );

        const resolvedDiagnostics = await Promise.all(diagnostics);
        this.view.dispatch(
            setDiagnostics(this.view.state, resolvedDiagnostics),
        );
    }

    private async requestCodeActions(
        range: LSP.Range,
        diagnosticCodes: string[],
    ): Promise<(LSP.Command | LSP.CodeAction)[] | null> {
        if (
            !(this.client.ready && this.client.capabilities?.codeActionProvider)
        ) {
            return null;
        }

        return await this.client.textDocumentCodeAction({
            textDocument: { uri: this.documentUri },
            range,
            context: {
                diagnostics: [
                    {
                        range,
                        code: diagnosticCodes[0],
                        source: this.languageId,
                        message: "",
                    },
                ],
            },
        });
    }

    public async requestRename(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ) {
        if (!this.client.ready) {
            showErrorMessage(view, "Language server not ready");
            return;
        }

        if (!this.client.capabilities?.renameProvider) {
            showErrorMessage(view, "Rename not supported by language server");
            return;
        }

        try {
            // First check if rename is possible at this position
            const prepareResult = await this.client.textDocumentPrepareRename({
                textDocument: { uri: this.documentUri },
                position: { line, character },
            });

            if (!prepareResult || "defaultBehavior" in prepareResult) {
                showErrorMessage(view, "Cannot rename this symbol");
                return;
            }

            // Create popup input
            const popup = document.createElement("div");
            popup.className = "cm-rename-popup";
            popup.style.cssText =
                "position: absolute; padding: 4px; background: white; border: 1px solid #ddd; box-shadow: 0 2px 8px rgba(0,0,0,.15); z-index: 99;";

            const input = document.createElement("input");
            input.type = "text";
            input.style.cssText =
                "width: 200px; padding: 4px; border: 1px solid #ddd;";

            // Get current word as default value
            const range =
                "range" in prepareResult ? prepareResult.range : prepareResult;
            const from = posToOffset(view.state.doc, range.start);
            if (from == null) {
                return;
            }
            const to = posToOffset(view.state.doc, range.end);
            input.value = view.state.doc.sliceString(from, to);

            popup.appendChild(input);

            // Position the popup near the word
            const coords = view.coordsAtPos(from);
            if (!coords) return;

            popup.style.left = `${coords.left}px`;
            popup.style.top = `${coords.bottom + 5}px`;

            // Handle input
            const handleRename = async () => {
                const newName = input.value.trim();
                if (!newName) {
                    showErrorMessage(view, "New name cannot be empty");
                    popup.remove();
                    return;
                }

                if (newName === input.defaultValue) {
                    popup.remove();
                    return;
                }

                try {
                    const edit = await this.client.textDocumentRename({
                        textDocument: { uri: this.documentUri },
                        position: { line, character },
                        newName,
                    });

                    if (!edit?.changes) {
                        showErrorMessage(view, "No changes to apply");
                        popup.remove();
                        return;
                    }

                    // Apply all changes
                    for (const [uri, changes] of Object.entries(edit.changes)) {
                        if (uri !== this.documentUri) {
                            showErrorMessage(
                                view,
                                "Multi-file rename not supported yet",
                            );
                            continue;
                        }

                        // Sort changes in reverse order to avoid position shifts
                        const sortedChanges = changes.sort((a, b) => {
                            const posA = posToOffset(
                                view.state.doc,
                                a.range.start,
                            );
                            const posB = posToOffset(
                                view.state.doc,
                                b.range.start,
                            );
                            return (posB ?? 0) - (posA ?? 0);
                        });

                        view.dispatch(
                            view.state.update({
                                changes: sortedChanges.map((change) => ({
                                    from:
                                        posToOffset(
                                            view.state.doc,
                                            change.range.start,
                                        ) ?? 0,
                                    to:
                                        posToOffset(
                                            view.state.doc,
                                            change.range.end,
                                        ) ?? 0,
                                    insert: change.newText,
                                })),
                            }),
                        );
                    }
                } catch (error) {
                    showErrorMessage(
                        view,
                        `Rename failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    );
                } finally {
                    popup.remove();
                }
            };

            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    handleRename();
                } else if (e.key === "Escape") {
                    popup.remove();
                }
                e.stopPropagation(); // Prevent editor handling
            });

            // Handle clicks outside
            const handleOutsideClick = (e: MouseEvent) => {
                if (!popup.contains(e.target as Node)) {
                    popup.remove();
                    document.removeEventListener(
                        "mousedown",
                        handleOutsideClick,
                    );
                }
            };
            document.addEventListener("mousedown", handleOutsideClick);

            // Add to DOM
            document.body.appendChild(popup);
            input.focus();
            input.select();
        } catch (error) {
            showErrorMessage(
                view,
                `Rename failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
        }
    }
}