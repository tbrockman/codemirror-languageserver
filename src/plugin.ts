import { autocompletion, insertCompletionText } from "@codemirror/autocomplete";
import { type Action, type Diagnostic, setDiagnostics } from "@codemirror/lint";
import {
    EditorView,
    type Tooltip,
    ViewPlugin,
    hoverTooltip,
} from "@codemirror/view";
import {
    Client,
    RequestManager,
    WebSocketTransport,
} from "@open-rpc/client-js";
import {
    CompletionItemKind,
    CompletionTriggerKind,
    DiagnosticSeverity,
} from "vscode-languageserver-protocol";

import type {
    Completion,
    CompletionContext,
    CompletionResult,
} from "@codemirror/autocomplete";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import type * as LSP from "vscode-languageserver-protocol";
import {
    codeActionsEnabled,
    completionEnabled,
    definitionEnabled,
    diagnosticsEnabled,
    documentUri,
    hoverEnabled,
    languageId,
    languageServerClient,
    renameEnabled,
    signatureHelpEnabled,
} from "./config.js";
import {
    formatContents,
    isEmptyDocumentation,
    isLSPTextEdit,
    offsetToPos,
    posToOffset,
    posToOffsetOrZero,
    prefixMatch,
    showErrorMessage,
} from "./utils.js";

const TIMEOUT = 10000;
const CHANGES_DELAY = 500;

const CompletionItemKindMap = Object.fromEntries(
    Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

const logger = console.log;

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Client to server then server to client
interface LSPRequestMap {
    initialize: [LSP.InitializeParams, LSP.InitializeResult];
    "textDocument/hover": [LSP.HoverParams, LSP.Hover];
    "textDocument/completion": [
        LSP.CompletionParams,
        LSP.CompletionItem[] | LSP.CompletionList | null,
    ];
    "completionItem/resolve": [LSP.CompletionItem, LSP.CompletionItem];
    "textDocument/definition": [
        LSP.DefinitionParams,
        LSP.Definition | LSP.DefinitionLink[] | null,
    ];
    "textDocument/codeAction": [
        LSP.CodeActionParams,
        (LSP.Command | LSP.CodeAction)[] | null,
    ];
    "textDocument/rename": [LSP.RenameParams, LSP.WorkspaceEdit | null];
    "textDocument/prepareRename": [
        LSP.PrepareRenameParams,
        LSP.Range | LSP.PrepareRenameResult | null,
    ];
    "textDocument/signatureHelp": [
        LSP.SignatureHelpParams,
        LSP.SignatureHelp | null,
    ];
}

// Client to server
interface LSPNotifyMap {
    initialized: LSP.InitializedParams;
    "textDocument/didChange": LSP.DidChangeTextDocumentParams;
    "textDocument/didOpen": LSP.DidOpenTextDocumentParams;
}

// Server to client
interface LSPEventMap {
    "textDocument/publishDiagnostics": LSP.PublishDiagnosticsParams;
}

type Notification = {
    [key in keyof LSPEventMap]: {
        jsonrpc: "2.0";
        id?: null | undefined;
        method: key;
        params: LSPEventMap[key];
    };
}[keyof LSPEventMap];

export class LanguageServerClient {
    public ready: boolean;
    public capabilities: LSP.ServerCapabilities | null;

    public initializePromise: Promise<void>;
    private rootUri: string;
    private workspaceFolders: LSP.WorkspaceFolder[] | null;
    private autoClose?: boolean;

    private transport: Transport;
    private requestManager: RequestManager;
    private client: Client;
    private initializationOptions: LanguageServerClientOptions["initializationOptions"];
    public clientCapabilities: LanguageServerClientOptions["capabilities"];

    private plugins: LanguageServerPlugin[];

    constructor(options: LanguageServerClientOptions) {
        this.ready = false;
        this.capabilities = null;
        this.rootUri = options.rootUri;
        this.workspaceFolders = options.workspaceFolders;
        this.autoClose = options.autoClose;
        this.plugins = [];
        this.transport = options.transport;
        this.initializationOptions = options.initializationOptions;
        this.clientCapabilities = options.capabilities;
        this.requestManager = new RequestManager([this.transport]);
        this.client = new Client(this.requestManager);

        this.client.onNotification((data) => {
            this.processNotification(data as Notification);
        });

        const webSocketTransport = this.transport as WebSocketTransport;
        if (webSocketTransport?.connection) {
            // XXX(hjr265): Need a better way to do this. Relevant issue:
            // https://github.com/FurqanSoftware/codemirror-languageserver/issues/9
            webSocketTransport.connection.addEventListener(
                "message",
                (message: { data: string }) => {
                    const data = JSON.parse(message.data);
                    if (data.method && data.id) {
                        webSocketTransport.connection.send(
                            JSON.stringify({
                                jsonrpc: "2.0",
                                id: data.id,
                                result: null,
                            }),
                        );
                    }
                },
            );
        }

        this.initializePromise = this.initialize();
    }

    protected getInitializationOptions(): LSP.InitializeParams["initializationOptions"] {
        const defaultClientCapabilities: LSP.ClientCapabilities = {
            textDocument: {
                hover: {
                    dynamicRegistration: true,
                    contentFormat: ["markdown", "plaintext"],
                },
                moniker: {},
                synchronization: {
                    dynamicRegistration: true,
                    willSave: false,
                    didSave: false,
                    willSaveWaitUntil: false,
                },
                codeAction: {
                    dynamicRegistration: true,
                    codeActionLiteralSupport: {
                        codeActionKind: {
                            valueSet: [
                                "",
                                "quickfix",
                                "refactor",
                                "refactor.extract",
                                "refactor.inline",
                                "refactor.rewrite",
                                "source",
                                "source.organizeImports",
                            ],
                        },
                    },
                    resolveSupport: {
                        properties: ["edit"],
                    },
                },
                completion: {
                    dynamicRegistration: true,
                    completionItem: {
                        snippetSupport: false,
                        commitCharactersSupport: true,
                        documentationFormat: ["markdown", "plaintext"],
                        deprecatedSupport: false,
                        preselectSupport: false,
                    },
                    contextSupport: false,
                },
                signatureHelp: {
                    dynamicRegistration: true,
                    signatureInformation: {
                        documentationFormat: ["markdown", "plaintext"],
                    },
                },
                declaration: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                definition: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                typeDefinition: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                implementation: {
                    dynamicRegistration: true,
                    linkSupport: true,
                },
                rename: {
                    dynamicRegistration: true,
                    prepareSupport: true,
                },
            },
            workspace: {
                didChangeConfiguration: {
                    dynamicRegistration: true,
                },
            },
        };

        const defaultOptions = {
            capabilities: this.clientCapabilities
                ? typeof this.clientCapabilities === "function"
                    ? this.clientCapabilities(defaultClientCapabilities)
                    : this.clientCapabilities
                : defaultClientCapabilities,
            initializationOptions: this.initializationOptions,
            processId: null,
            rootUri: this.rootUri,
            workspaceFolders: this.workspaceFolders,
        };

        return defaultOptions;
    }

    public async initialize() {
        const { capabilities } = await this.request(
            "initialize",
            this.getInitializationOptions(),
            TIMEOUT * 3,
        );
        this.capabilities = capabilities;
        this.notify("initialized", {});
        this.ready = true;
    }

    public close() {
        this.client.close();
    }

    public textDocumentDidOpen(params: LSP.DidOpenTextDocumentParams) {
        return this.notify("textDocument/didOpen", params);
    }

    public textDocumentDidChange(params: LSP.DidChangeTextDocumentParams) {
        return this.notify("textDocument/didChange", params);
    }

    public async textDocumentHover(params: LSP.HoverParams) {
        return await this.request("textDocument/hover", params, TIMEOUT);
    }

    public async textDocumentCompletion(params: LSP.CompletionParams) {
        return await this.request("textDocument/completion", params, TIMEOUT);
    }

    public async completionItemResolve(item: LSP.CompletionItem) {
        return await this.request("completionItem/resolve", item, TIMEOUT);
    }

    public async textDocumentDefinition(params: LSP.DefinitionParams) {
        return await this.request("textDocument/definition", params, TIMEOUT);
    }

    public async textDocumentCodeAction(params: LSP.CodeActionParams) {
        return await this.request("textDocument/codeAction", params, TIMEOUT);
    }

    public async textDocumentRename(params: LSP.RenameParams) {
        return await this.request("textDocument/rename", params, TIMEOUT);
    }

    public async textDocumentPrepareRename(params: LSP.PrepareRenameParams) {
        return await this.request(
            "textDocument/prepareRename",
            params,
            TIMEOUT,
        );
    }

    public async textDocumentSignatureHelp(params: LSP.SignatureHelpParams) {
        return await this.request(
            "textDocument/signatureHelp",
            params,
            TIMEOUT,
        );
    }

    public attachPlugin(plugin: LanguageServerPlugin) {
        this.plugins.push(plugin);
    }

    public detachPlugin(plugin: LanguageServerPlugin) {
        const i = this.plugins.indexOf(plugin);
        if (i === -1) {
            return;
        }
        this.plugins.splice(i, 1);
        if (this.autoClose) {
            this.close();
        }
    }

    protected request<K extends keyof LSPRequestMap>(
        method: K,
        params: LSPRequestMap[K][0],
        timeout: number,
    ): Promise<LSPRequestMap[K][1]> {
        return this.client.request({ method, params }, timeout);
    }

    protected notify<K extends keyof LSPNotifyMap>(
        method: K,
        params: LSPNotifyMap[K],
    ): Promise<LSPNotifyMap[K]> {
        return this.client.notify({ method, params });
    }

    protected processNotification(notification: Notification) {
        for (const plugin of this.plugins) {
            plugin.processNotification(notification);
        }
    }
}

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
        }, CHANGES_DELAY);
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
        // Check if hover is enabled
        if (!view.state.facet(hoverEnabled)) {
            return null;
        }

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
        if (isEmptyDocumentation(contents)) {
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
        // Check if completion is enabled
        if (!context.state.facet(completionEnabled)) {
            return null;
        }

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
                        if (!content) {
                            return null;
                        }
                        if (isEmptyDocumentation(content)) {
                            return null;
                        }
                        if (this.allowHTMLContent) {
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
        view: EditorView,
        { line, character }: { line: number; character: number },
    ) {
        // Check if definition is enabled
        if (!view.state.facet(definitionEnabled)) {
            return;
        }

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
            view.dispatch(
                view.state.update({
                    selection: {
                        anchor: posToOffsetOrZero(view.state.doc, range.start),
                        head: posToOffset(view.state.doc, range.end),
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

        // Check if diagnostics are enabled
        const diagEnabled = this.view.state.facet(diagnosticsEnabled);
        if (!diagEnabled) {
            // Clear any existing diagnostics if disabled
            this.view.dispatch(setDiagnostics(this.view.state, []));
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
        // Check if code actions are enabled
        if (!this.view.state.facet(codeActionsEnabled)) {
            return null;
        }

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
        // Check if rename is enabled
        if (!view.state.facet(renameEnabled)) {
            return;
        }

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
            const prepareResult = await this.client
                .textDocumentPrepareRename({
                    textDocument: { uri: this.documentUri },
                    position: { line, character },
                })
                .catch(() => {
                    // In case prepareRename is not supported,
                    // we fallback to the default implementation
                    return this.prepareRenameFallback(view, {
                        line,
                        character,
                    });
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

                    await this.applyRenameEdit(view, edit);
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

    /**
     * Request signature help from the language server
     * @param view The editor view
     * @param position The cursor position
     * @returns A tooltip with the signature help information or null if not available
     */
    public async requestSignatureHelp(
        view: EditorView,
        {
            line,
            character,
        }: {
            line: number;
            character: number;
        },
        triggerCharacter: string | undefined = undefined,
    ): Promise<Tooltip | null> {
        // Check if signature help is enabled
        if (
            !(
                view.state.facet(signatureHelpEnabled) &&
                this.client.ready &&
                this.client.capabilities?.signatureHelpProvider
            )
        ) {
            return null;
        }

        try {
            // Send the current document state
            this.sendChange({ documentText: view.state.doc.toString() });

            // Request signature help
            const result = await this.client.textDocumentSignatureHelp({
                textDocument: { uri: this.documentUri },
                position: { line, character },
                context: {
                    isRetrigger: false,
                    triggerKind: 1, // Invoked
                    triggerCharacter,
                },
            });

            if (!result?.signatures || result.signatures.length === 0) {
                return null;
            }

            // Create the tooltip container
            const dom = this.createTooltipContainer();

            // Get active signature
            const activeSignatureIndex = result.activeSignature ?? 0;
            const activeSignature =
                result.signatures[activeSignatureIndex] || result.signatures[0];

            if (!activeSignature) {
                return null;
            }

            const activeParameterIndex =
                result.activeParameter ?? activeSignature.activeParameter ?? 0;

            // Create and add signature display element
            const signatureElement = this.createSignatureElement(
                activeSignature,
                activeParameterIndex,
            );
            dom.appendChild(signatureElement);

            // Add documentation if available
            if (activeSignature.documentation) {
                dom.appendChild(
                    this.createDocumentationElement(
                        activeSignature.documentation,
                    ),
                );
            }

            // Add parameter documentation if available
            const activeParam =
                activeSignature.parameters?.[activeParameterIndex];

            if (activeParam?.documentation) {
                dom.appendChild(
                    this.createParameterDocElement(activeParam.documentation),
                );
            }

            // Position tooltip at cursor
            const pos = posToOffset(view.state.doc, { line, character });
            if (pos == null) {
                return null;
            }

            return {
                pos,
                end: pos,
                create: (_view) => ({ dom }),
                above: false,
            };
        } catch (error) {
            console.error("Signature help error:", error);
            return null;
        }
    }

    /**
     * Creates the main tooltip container for signature help
     */
    private createTooltipContainer(): HTMLElement {
        const dom = document.createElement("div");
        dom.classList.add("cm-signature-help");
        dom.style.cssText = "padding: 6px; max-width: 400px;";
        return dom;
    }

    /**
     * Creates the signature element with parameter highlighting
     */
    private createSignatureElement(
        signature: LSP.SignatureInformation,
        activeParameterIndex: number,
    ): HTMLElement {
        const signatureElement = document.createElement("div");
        signatureElement.classList.add("cm-signature");
        signatureElement.style.cssText =
            "font-family: monospace; margin-bottom: 4px;";

        if (!signature.label || typeof signature.label !== "string") {
            signatureElement.textContent = "Signature information unavailable";
            return signatureElement;
        }

        const signatureText = signature.label;
        const parameters = signature.parameters || [];

        // If there are no parameters or no active parameter, just show the signature text
        if (parameters.length === 0 || !parameters[activeParameterIndex]) {
            signatureElement.textContent = signatureText;
            return signatureElement;
        }

        // Handle parameter highlighting based on the parameter label type
        const paramLabel = parameters[activeParameterIndex].label;

        if (typeof paramLabel === "string") {
            // Simple string replacement
            signatureElement.textContent = signatureText.replace(
                paramLabel,
                `«${paramLabel}»`,
            );
        } else if (Array.isArray(paramLabel) && paramLabel.length === 2) {
            // Handle array format [startIndex, endIndex]
            this.applyRangeHighlighting(
                signatureElement,
                signatureText,
                paramLabel[0],
                paramLabel[1],
            );
        } else {
            signatureElement.textContent = signatureText;
        }

        return signatureElement;
    }

    /**
     * Applies parameter highlighting using a range approach
     */
    private applyRangeHighlighting(
        element: HTMLElement,
        text: string,
        startIndex: number,
        endIndex: number,
    ): void {
        // Clear any existing content
        element.textContent = "";

        // Split the text into three parts: before, parameter, after
        const beforeParam = text.substring(0, startIndex);
        const param = text.substring(startIndex, endIndex);
        const afterParam = text.substring(endIndex);

        // Add the parts to the element
        element.appendChild(document.createTextNode(beforeParam));

        const paramSpan = document.createElement("span");
        paramSpan.classList.add("cm-signature-active-param");
        paramSpan.style.cssText =
            "font-weight: bold; text-decoration: underline;";
        paramSpan.textContent = param;
        element.appendChild(paramSpan);

        element.appendChild(document.createTextNode(afterParam));
    }

    /**
     * Creates the documentation element for signatures
     */
    private createDocumentationElement(
        documentation: string | LSP.MarkupContent,
    ): HTMLElement {
        const docsElement = document.createElement("div");
        docsElement.classList.add("cm-signature-docs");
        docsElement.style.cssText = "margin-top: 4px; color: #666;";

        const formattedContent = formatContents(documentation);

        if (this.allowHTMLContent) {
            docsElement.innerHTML = formattedContent;
        } else {
            docsElement.textContent = formattedContent;
        }

        return docsElement;
    }

    /**
     * Creates the parameter documentation element
     */
    private createParameterDocElement(
        documentation: string | LSP.MarkupContent,
    ): HTMLElement {
        const paramDocsElement = document.createElement("div");
        paramDocsElement.classList.add("cm-parameter-docs");
        paramDocsElement.style.cssText =
            "margin-top: 4px; font-style: italic; border-top: 1px solid #eee; padding-top: 4px;";

        const formattedContent = formatContents(documentation);

        if (this.allowHTMLContent) {
            paramDocsElement.innerHTML = formattedContent;
        } else {
            paramDocsElement.textContent = formattedContent;
        }

        return paramDocsElement;
    }

    /**
     * Fallback implementation of prepareRename.
     * We try to find the word at the cursor position and return the range of the word.
     */
    private prepareRenameFallback(
        view: EditorView,
        { line, character }: { line: number; character: number },
    ): LSP.PrepareRenameResult | null {
        const doc = view.state.doc;
        const lineText = doc.line(line + 1).text;
        const wordRegex = /\w+/g;
        let match: RegExpExecArray | null;
        let start = character;
        let end = character;
        // Find all word matches in the line
        // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
        while ((match = wordRegex.exec(lineText)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;

            // Check if cursor position is within or at the boundaries of this word
            if (character >= matchStart && character <= matchEnd) {
                start = matchStart;
                end = matchEnd;
                break;
            }
        }

        if (start === character && end === character) {
            return null; // No word found at cursor position
        }

        return {
            range: {
                start: {
                    line,
                    character: start,
                },
                end: {
                    line,
                    character: end,
                },
            },
            placeholder: lineText.slice(start, end),
        };
    }

    /**
     * Apply workspace edit from rename operation
     * @param view The editor view
     * @param edit The workspace edit to apply
     * @returns True if changes were applied successfully
     */
    private async applyRenameEdit(
        view: EditorView,
        edit: LSP.WorkspaceEdit | null,
    ): Promise<boolean> {
        if (!edit) {
            showErrorMessage(view, "No edit returned from language server");
            return false;
        }

        const changesMap = edit.changes ?? {};
        const documentChanges = edit.documentChanges ?? [];

        if (
            Object.keys(changesMap).length === 0 &&
            documentChanges.length === 0
        ) {
            showErrorMessage(view, "No changes to apply");
            return false;
        }

        // Handle documentChanges (preferred) if available
        if (documentChanges.length > 0) {
            for (const docChange of documentChanges) {
                if ("textDocument" in docChange) {
                    // This is a TextDocumentEdit
                    const uri = docChange.textDocument.uri;

                    if (uri !== this.documentUri) {
                        showErrorMessage(
                            view,
                            "Multi-file rename not supported yet",
                        );
                        continue;
                    }

                    // Sort edits in reverse order to avoid position shifts
                    const sortedEdits = docChange.edits.sort((a, b) => {
                        const posA = posToOffset(view.state.doc, a.range.start);
                        const posB = posToOffset(view.state.doc, b.range.start);
                        return (posB ?? 0) - (posA ?? 0);
                    });

                    // Create a single transaction with all changes
                    const changes = sortedEdits.map((edit) => ({
                        from:
                            posToOffset(view.state.doc, edit.range.start) ?? 0,
                        to: posToOffset(view.state.doc, edit.range.end) ?? 0,
                        insert: edit.newText,
                    }));

                    view.dispatch(view.state.update({ changes }));
                    return true;
                }

                // This is a CreateFile, RenameFile, or DeleteFile operation
                showErrorMessage(
                    view,
                    "File creation, deletion, or renaming operations not supported yet",
                );
                return false;
            }
        }
        // Fall back to changes if documentChanges is not available
        else if (Object.keys(changesMap).length > 0) {
            // Apply all changes
            for (const [uri, changes] of Object.entries(changesMap)) {
                if (uri !== this.documentUri) {
                    showErrorMessage(
                        view,
                        "Multi-file rename not supported yet",
                    );
                    continue;
                }

                // Sort changes in reverse order to avoid position shifts
                const sortedChanges = changes.sort((a, b) => {
                    const posA = posToOffset(view.state.doc, a.range.start);
                    const posB = posToOffset(view.state.doc, b.range.start);
                    return (posB ?? 0) - (posA ?? 0);
                });

                // Create a single transaction with all changes
                const changeSpecs = sortedChanges.map((change) => ({
                    from: posToOffset(view.state.doc, change.range.start) ?? 0,
                    to: posToOffset(view.state.doc, change.range.end) ?? 0,
                    insert: change.newText,
                }));

                view.dispatch(view.state.update({ changes: changeSpecs }));
            }
        }

        return false;
    }
}

/**
 * Options for configuring the language server client
 */
interface LanguageServerClientOptions {
    /** The root URI of the workspace, used for LSP initialization */
    rootUri: string;
    /** List of workspace folders to send to the language server */
    workspaceFolders: LSP.WorkspaceFolder[] | null;
    /** Transport mechanism for communicating with the language server */
    transport: Transport;
    /** Whether to automatically close the connection when the editor is destroyed */
    autoClose?: boolean;
    /**
     * Client capabilities to send to the server during initialization.
     * Can be an object or a function that modifies the default capabilities.
     */
    capabilities?:
        | LSP.InitializeParams["capabilities"]
        | ((
              defaultCapabilities: LSP.InitializeParams["capabilities"],
          ) => LSP.InitializeParams["capabilities"]);
    /** Additional initialization options to send to the language server */
    initializationOptions?: LSP.InitializeParams["initializationOptions"];
}

/**
 * Keyboard shortcut configuration for LSP features
 */
interface KeyboardShortcuts {
    /** Keyboard shortcut for rename operations (default: F2) */
    rename?: string;
    /** Keyboard shortcut for go to definition (default: Ctrl/Cmd+Click) */
    goToDefinition?: string;
    /** Keyboard shortcut for signature help (default: Ctrl/Cmd+Shift+Space) */
    signatureHelp?: string;
}

/**
 * Result of a definition lookup operation
 */
interface DefinitionResult {
    /** URI of the target document containing the definition */
    uri: string;
    /** Range in the document where the definition is located */
    range: LSP.Range;
    /** Whether the definition is in a different file than the current document */
    isExternalDocument: boolean;
}

/**
 * Complete options for configuring the language server integration
 */
interface LanguageServerOptions {
    /** Pre-configured language server client instance or options */
    client: LanguageServerClient;
    /** Whether to allow HTML content in hover tooltips and other UI elements */
    allowHTMLContent?: boolean;
    /** URI of the current document being edited. If not provided, must be passed via the documentUri facet. */
    documentUri?: string;
    /** Language identifier (e.g., 'typescript', 'javascript', etc.). If not provided, must be passed via the languageId facet. */
    languageId?: string;
    /** Configuration for keyboard shortcuts */
    keyboardShortcuts?: KeyboardShortcuts;
    /** Callback triggered when a go-to-definition action is performed */
    onGoToDefinition?: (result: DefinitionResult) => void;

    // Feature toggle options

    /** Whether to enable diagnostic messages (default: true) */
    diagnosticsEnabled?: boolean;
    /** Whether to enable hover tooltips (default: true) */
    hoverEnabled?: boolean;
    /** Whether to enable code completion (default: true) */
    completionEnabled?: boolean;
    /** Whether to enable go-to-definition (default: true) */
    definitionEnabled?: boolean;
    /** Whether to enable rename functionality (default: true) */
    renameEnabled?: boolean;
    /** Whether to enable code actions (default: true) */
    codeActionsEnabled?: boolean;
    /** Whether to enable signature help (default: true) */
    signatureHelpEnabled?: boolean;

    /**
     * Configuration for the completion feature.
     * If not provided, the default completion config will be used.
     */
    completionConfig?: Parameters<typeof autocompletion>[0];
    /**
     * Configuration for the hover feature.
     * If not provided, the default hover config will be used.
     */
    hoverConfig?: Parameters<typeof hoverTooltip>[1];

    /**
     * Regular expression for determining when to show completions.
     * Default is to show completions when typing a word, after a dot, or after a slash.
     */
    completionMatchBefore?: RegExp;
}

/**
 * Options for connecting to a language server via WebSocket
 */
interface LanguageServerWebsocketOptions
    extends Omit<LanguageServerOptions, "client">,
        Omit<LanguageServerClientOptions, "transport"> {
    /** WebSocket URI for connecting to the language server */
    serverUri: `ws://${string}` | `wss://${string}`;
}

export function languageServer(options: LanguageServerWebsocketOptions) {
    const { serverUri, ...rest } = options;
    return languageServerWithClient({
        ...rest,
        client: new LanguageServerClient({
            ...options,
            transport: new WebSocketTransport(serverUri),
            autoClose: true,
        }),
    });
}

export function languageServerWithClient(options: LanguageServerOptions) {
    let plugin: LanguageServerPlugin | null = null;
    const shortcuts = {
        rename: "F2",
        goToDefinition: "ctrlcmd", // ctrlcmd means Ctrl on Windows/Linux, Cmd on Mac
        signatureHelp: "ctrlcmdshift.Space", // Ctrl/Cmd+Shift+Space
        ...options.keyboardShortcuts,
    };

    const lsClient = options.client;

    const {
        diagnosticsEnabled: isDiagnosticsEnabled = true,
        hoverEnabled: isHoverEnabled = true,
        completionEnabled: isCompletionEnabled = true,
        definitionEnabled: isDefinitionEnabled = true,
        renameEnabled: isRenameEnabled = true,
        codeActionsEnabled: isCodeActionsEnabled = true,
        signatureHelpEnabled: isSignatureHelpEnabled = true,
    } = options;

    // Extract feature toggles from options
    const featureToggles = [
        // Default all features to true if not specified
        diagnosticsEnabled.of(isDiagnosticsEnabled),
        hoverEnabled.of(isHoverEnabled),
        completionEnabled.of(isCompletionEnabled),
        definitionEnabled.of(isDefinitionEnabled),
        renameEnabled.of(isRenameEnabled),
        codeActionsEnabled.of(isCodeActionsEnabled),
        signatureHelpEnabled.of(isSignatureHelpEnabled),
    ];

    // Create base extensions array
    const extensions = [
        languageServerClient.of(lsClient),
        // Add all the feature toggle facets
        ...featureToggles,
        ViewPlugin.define((view) => {
            plugin = new LanguageServerPlugin(
                lsClient,
                view.state.facet(documentUri),
                view.state.facet(languageId),
                view,
                options.allowHTMLContent,
                options.onGoToDefinition,
            );
            return plugin;
        }),
    ];

    // Can be added externally, if depends on other facets
    if (options.documentUri) {
        extensions.push(documentUri.of(options.documentUri));
    }

    // Can be added externally, if depends on other facets
    if (options.languageId) {
        extensions.push(languageId.of(options.languageId));
    }

    // Only add hover tooltip if enabled
    if (isHoverEnabled) {
        extensions.push(
            hoverTooltip((view, pos) => {
                if (plugin == null) {
                    return null;
                }
                return plugin.requestHoverTooltip(
                    view,
                    offsetToPos(view.state.doc, pos),
                );
            }, options.hoverConfig),
        );
    }

    // Add signature help support if enabled
    if (isSignatureHelpEnabled) {
        extensions.push(
            EditorView.updateListener.of(async (update) => {
                if (!(plugin && update.docChanged)) return;

                // Early exit if signature help capability is not supported
                if (!plugin.client.capabilities?.signatureHelpProvider) return;

                const triggerChars = plugin.client.capabilities
                    .signatureHelpProvider.triggerCharacters || ["(", ","];
                let triggerCharacter: string | undefined;

                // Check if changes include trigger characters
                const changes = update.changes;
                let shouldTrigger = false;
                let triggerPos = -1;

                changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
                    if (shouldTrigger) return; // Skip if already found a trigger

                    const text = inserted.toString();
                    if (!text) return;

                    for (const char of triggerChars) {
                        if (text.includes(char)) {
                            shouldTrigger = true;
                            triggerPos = toB;
                            triggerCharacter = char;
                            break;
                        }
                    }
                });

                if (shouldTrigger && triggerPos >= 0) {
                    const pos = offsetToPos(update.state.doc, triggerPos);
                    if (pos) {
                        // Show signature help tooltip
                        const tooltip = await plugin.requestSignatureHelp(
                            update.view,
                            pos,
                            triggerCharacter,
                        );

                        if (tooltip) {
                            // Create and show the tooltip manually
                            const { pos: tooltipPos, create } = tooltip;
                            const tooltipView = create(update.view);

                            const tooltipElement =
                                document.createElement("div");
                            tooltipElement.className =
                                "cm-tooltip cm-signature-tooltip";
                            tooltipElement.style.position = "absolute";

                            tooltipElement.appendChild(tooltipView.dom);

                            // Position the tooltip
                            const coords = update.view.coordsAtPos(tooltipPos);
                            if (coords) {
                                tooltipElement.style.left = `${coords.left}px`;
                                tooltipElement.style.top = `${coords.bottom + 5}px`;

                                // Add to DOM
                                document.body.appendChild(tooltipElement);

                                // Remove after a delay or on editor changes
                                setTimeout(() => {
                                    tooltipElement.remove();
                                }, 10000); // Show for 10 seconds

                                // Also remove on any user input
                                const removeTooltip = () => {
                                    tooltipElement.remove();
                                    update.view.dom.removeEventListener(
                                        "keydown",
                                        removeTooltip,
                                    );
                                    update.view.dom.removeEventListener(
                                        "mousedown",
                                        removeTooltip,
                                    );
                                };

                                update.view.dom.addEventListener(
                                    "keydown",
                                    removeTooltip,
                                );
                                update.view.dom.addEventListener(
                                    "mousedown",
                                    removeTooltip,
                                );
                            }
                        }
                    }
                }
            }),
        );
    }

    // Only add autocompletion if enabled
    if (isCompletionEnabled) {
        extensions.push(
            autocompletion({
                ...options.completionConfig,
                override: [
                    /**
                     * Completion source function that handles LSP-based autocompletion
                     *
                     * This function determines the appropriate trigger kind and character,
                     * checks if completion should be shown, and delegates to the plugin's
                     * requestCompletion method.
                     *
                     * @param context The completion context from CodeMirror
                     * @returns A CompletionResult or null if no completions are available
                     */
                    async (context) => {
                        // Don't proceed if plugin isn't initialized
                        if (plugin == null) {
                            return null;
                        }

                        const { state, pos } = context;

                        const result = getCompletionTriggerKind(
                            context,
                            plugin.client.capabilities?.completionProvider
                                ?.triggerCharacters ?? [],
                            options.completionMatchBefore,
                        );

                        if (result == null) {
                            return null;
                        }

                        // Request completions from the language server
                        return await plugin.requestCompletion(
                            context,
                            offsetToPos(state.doc, pos),
                            result,
                        );
                    },
                ],
            }),
        );
    }

    // Add event handlers for rename and go to definition
    extensions.push(
        EditorView.domEventHandlers({
            click: (event, view) => {
                // Check if definition is enabled
                if (!view.state.facet(definitionEnabled)) return;

                if (
                    shortcuts.goToDefinition === "ctrlcmd" &&
                    (event.ctrlKey || event.metaKey)
                ) {
                    const pos = view.posAtCoords({
                        x: event.clientX,
                        y: event.clientY,
                    });
                    if (pos && plugin) {
                        plugin
                            .requestDefinition(
                                view,
                                offsetToPos(view.state.doc, pos),
                            )
                            .catch((error) =>
                                showErrorMessage(
                                    view,
                                    `Go to definition failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                                ),
                            );
                        event.preventDefault();
                    }
                }
            },
            keydown: (event, view) => {
                if (event.key === shortcuts.rename && plugin) {
                    // Check if rename is enabled
                    if (!view.state.facet(renameEnabled)) return;

                    const pos = view.state.selection.main.head;
                    plugin.requestRename(
                        view,
                        offsetToPos(view.state.doc, pos),
                    );
                    event.preventDefault();
                    return true;
                }

                if (
                    shortcuts.goToDefinition !== "ctrlcmd" &&
                    event.key === shortcuts.goToDefinition &&
                    plugin
                ) {
                    // Check if definition is enabled
                    if (!view.state.facet(definitionEnabled)) return;

                    const pos = view.state.selection.main.head;
                    plugin
                        .requestDefinition(
                            view,
                            offsetToPos(view.state.doc, pos),
                        )
                        .catch((error) =>
                            showErrorMessage(
                                view,
                                `Go to definition failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                            ),
                        );
                    event.preventDefault();
                    return true;
                }
            },
        }),
    );

    return extensions;
}

export function getCompletionTriggerKind(
    context: CompletionContext,
    triggerCharacters: string[],
    matchBeforePattern?: RegExp,
) {
    const { state, pos, explicit } = context;
    const line = state.doc.lineAt(pos);

    // Determine trigger kind and character
    let triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked;
    let triggerCharacter: string | undefined;

    // Check if completion was triggered by a special character
    const prevChar = line.text[pos - line.from - 1] || "";
    const isTriggerChar = triggerCharacters?.includes(prevChar);

    if (!explicit && isTriggerChar) {
        triggerKind = CompletionTriggerKind.TriggerCharacter;
        triggerCharacter = prevChar;
    }

    // For manual invocation, only show completions when typing
    // Use the provided pattern or default to words, dots, or slashes
    if (
        triggerKind === CompletionTriggerKind.Invoked &&
        !context.matchBefore(matchBeforePattern || /\w+\.|\/|\w+$/)
    ) {
        return null;
    }

    return { triggerKind, triggerCharacter };
}
