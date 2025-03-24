import type LSP from "vscode-languageserver-protocol";
import { LanguageServerClient, LanguageServerClientOptions, LSPNotifyMap, LSPRequestMap, Notification } from "./types.js";
import { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import { Client, RequestManager, WebSocketTransport } from "@open-rpc/client-js";
import { LanguageServerPlugin } from "../extension/plugin.js";

export class LanguageServerClientImpl implements LanguageServerClient {
    public ready: boolean;
    public capabilities: LSP.ServerCapabilities | null;

    public initializePromise: Promise<void>;
    private rootUri: string;
    private workspaceFolders: LSP.WorkspaceFolder[] | null;
    private autoClose?: boolean;

    private transport: Transport;
    private requestManager: RequestManager;
    private client: Client;
    private timeout: number;
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
        this.timeout = options.timeout || 10000;

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
            this.timeout * 3,
        );
        this.capabilities = capabilities;
        this.notify("initialized", {});
        this.ready = true;
    }

    public async started(): Promise<boolean> {
        await this.initializePromise;
        return this.ready;
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
        return await this.request("textDocument/hover", params, this.timeout);
    }

    public async textDocumentCompletion(params: LSP.CompletionParams) {
        return await this.request("textDocument/completion", params, this.timeout);
    }

    public async completionItemResolve(item: LSP.CompletionItem) {
        return await this.request("completionItem/resolve", item, this.timeout);
    }

    public async textDocumentDefinition(params: LSP.DefinitionParams) {
        return await this.request("textDocument/definition", params, this.timeout);
    }

    public async textDocumentCodeAction(params: LSP.CodeActionParams) {
        return await this.request("textDocument/codeAction", params, this.timeout);
    }

    public async textDocumentRename(params: LSP.RenameParams) {
        return await this.request("textDocument/rename", params, this.timeout);
    }

    public async textDocumentPrepareRename(params: LSP.PrepareRenameParams) {
        return await this.request(
            "textDocument/prepareRename",
            params,
            this.timeout,
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