import { autocompletion } from "@codemirror/autocomplete";
import { Facet } from "@codemirror/state";
import {
    EditorView,
    ViewPlugin,
    hoverTooltip,
} from "@codemirror/view";
import {
    WebSocketTransport,
} from "@open-rpc/client-js";
import {
    CompletionTriggerKind,
} from "vscode-languageserver-protocol";
import {
    offsetToPos,
    showErrorMessage,
} from "../utils/index.js";
import { LanguageServerClient, LanguageServerOptions, LanguageServerWebsocketOptions } from "../types.js";
import { LanguageServerPlugin } from "./plugin.js";
import { LanguageServerClientImpl } from "../lsp/client.js";


// biome-ignore lint/style/noNonNullAssertion: <explanation>
const useLast = <T>(values: readonly T[]): T => values.at(-1)!;

const client = Facet.define<LanguageServerClient, LanguageServerClient>({
    combine: useLast,
});
const documentUri = Facet.define<string, string>({ combine: useLast });
const languageId = Facet.define<string, string>({ combine: useLast });

export function languageServer(options: LanguageServerWebsocketOptions) {
    const { serverUri, ...rest } = options;
    return languageServerWithTransport({
        ...rest,
        transport: new WebSocketTransport(serverUri),
    });
}

export function languageServerWithTransport(options: LanguageServerOptions) {
    let plugin: LanguageServerPlugin | null = null;
    const shortcuts = {
        rename: "F2",
        goToDefinition: "ctrlcmd", // ctrlcmd means Ctrl on Windows/Linux, Cmd on Mac
        ...options.keyboardShortcuts,
    };

    const lsClient =
        options.client ||
        new LanguageServerClientImpl({ ...options, autoClose: true });

    return [
        client.of(lsClient),
        documentUri.of(options.documentUri),
        languageId.of(options.languageId),
        ViewPlugin.define((view) => {
            plugin = new LanguageServerPlugin(
                lsClient,
                options.documentUri,
                options.languageId,
                view,
                options.allowHTMLContent,
                options.onGoToDefinition,
            );
            return plugin;
        }),
        hoverTooltip(
            (view, pos) => {
                console.log('hover tooltip listener');
                return plugin?.requestHoverTooltip(
                    view,
                    offsetToPos(view.state.doc, pos),
                ) ?? null;
            }
        ),
        autocompletion({
            override: [
                async (context) => {
                    if (plugin == null) {
                        return null;
                    }

                    console.log('autocompletion?', context)

                    const { state, pos, explicit } = context;
                    const line = state.doc.lineAt(pos);
                    let trigKind: CompletionTriggerKind =
                        CompletionTriggerKind.Invoked;
                    let trigChar: string | undefined;
                    if (
                        !explicit &&
                        plugin.client.capabilities?.completionProvider?.triggerCharacters?.includes(
                            line.text[pos - line.from - 1] || "",
                        )
                    ) {
                        trigKind = CompletionTriggerKind.TriggerCharacter;
                        trigChar = line.text[pos - line.from - 1];
                    }
                    if (
                        trigKind === CompletionTriggerKind.Invoked &&
                        !context.matchBefore(/\w+$/)
                    ) {
                        return null;
                    }
                    return await plugin.requestCompletion(
                        context,
                        offsetToPos(state.doc, pos),
                        {
                            triggerCharacter: trigChar,
                            triggerKind: trigKind,
                        },
                    );
                },
            ],
        }),
        EditorView.domEventHandlers({
            click: (event, view) => {
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
                    const pos = view.state.selection.main.head;
                    plugin.requestRename(
                        view,
                        offsetToPos(view.state.doc, pos),
                    );
                    event.preventDefault();
                } else if (
                    shortcuts.goToDefinition !== "ctrlcmd" &&
                    event.key === shortcuts.goToDefinition &&
                    plugin
                ) {
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
                }
            },
        }),
    ];
}

export { LanguageServerPlugin } from './plugin.js';
export { languageServerTheme } from './theme.js';