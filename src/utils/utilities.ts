import * as vscode from "vscode";

export const outputChannel = vscode.window.createOutputChannel("crowd-pilot");

export function logToOutput(
    message: string,
    type: "info" | "success" | "error" = "info",
) {
    const time = new Date().toLocaleTimeString();

    outputChannel.appendLine(`${time} [${type}] ${message}`);
    console.log(message);
}
