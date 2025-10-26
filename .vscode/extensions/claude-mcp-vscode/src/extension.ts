import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Global flag to prevent concurrent commit generation
let isGeneratingCommit = false;

// Debug log file path
let debugLogPath: string = '';

// Output channel for extension logs
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    console.log(logLine.trim());
    if (debugLogPath) {
        fs.appendFileSync(debugLogPath, logLine);
    }
    if (outputChannel) {
        outputChannel.appendLine(message);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('✓ Commit Message AI extension activated successfully');

    // Create output channel
    outputChannel = vscode.window.createOutputChannel('Commit Message AI');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('✓ Commit Message AI extension activated');

    // Show status bar item to indicate extension is loaded
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(robot) Commit Message AI";
    statusBarItem.tooltip = "Commit Message AI is active";
    statusBarItem.command = "claude-mcp-vscode.callMCP";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Initialize git change listener to enable/disable button
    const initializeGitListener = async () => {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            return;
        }

        // Wait for git extension to activate
        const gitAPI = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
        const git = gitAPI.getAPI(1);

        // Function to update button state
        const updateButtonState = () => {
            if (git.repositories.length > 0) {
                const repo = git.repositories[0];
                const hasStagedChanges = (repo.state.indexChanges?.length || 0) > 0;
                vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.hasStagedChanges', hasStagedChanges);
            } else {
                vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.hasStagedChanges', false);
            }
        };

        // Update immediately
        updateButtonState();

        // Listen for repository changes
        git.repositories.forEach((repo: any) => {
            repo.state.onDidChange(() => updateButtonState());
        });

        // Listen for new repositories
        git.onDidOpenRepository((repo: any) => {
            updateButtonState();
            repo.state.onDidChange(() => updateButtonState());
        });
    };

    // Initialize git listener asynchronously
    initializeGitListener().catch(err => {
        console.error('Failed to initialize git listener:', err);
        // Set to false as fallback
        vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.hasStagedChanges', false);
    });

    // Register no-op command for disabled state
    let clickCount = 0;
    let noOpDisposable = vscode.commands.registerCommand('claude-mcp-vscode.noOp', () => {
        if (isGeneratingCommit) {
            clickCount++;
            const messages = [
                'Working on it...',
                'Still working... patience is a virtue! 🧘',
                'Hey, I said working on it! ⏳',
                'Seriously, give me a moment... 🤖',
                'Are you testing my patience? 😅',
                'OK, now you\'re just clicking for fun... 🎮',
                'I\'m doing AI magic here! Takes time! ✨',
                'Each click makes it slower... just kidding! 🐌',
                'Brewing the perfect commit message... ☕',
                'Rome wasn\'t built in a day! 🏛️',
                'You must be really excited! Me too! 🎉',
                'Pro tip: Watching the pot doesn\'t make it boil faster 👀',
                'Computing... beep boop beep... 🤖',
                'Nearly there... (not really, same progress) 📊',
                'Your enthusiasm is noted and appreciated! 💝'
            ];
            const messageIndex = Math.min(clickCount - 1, messages.length - 1);
            vscode.window.showInformationMessage(messages[messageIndex]);
        } else {
            clickCount = 0; // Reset when not generating
            vscode.window.showInformationMessage('Stage some changes first to generate a commit message');
        }
    });
    context.subscriptions.push(noOpDisposable);

    // Register command to show output channel
    let showOutputDisposable = vscode.commands.registerCommand('claude-mcp-vscode.showOutput', () => {
        outputChannel.show(true); // true = preserve focus on current editor
    });
    context.subscriptions.push(showOutputDisposable);

    // Register the command
    let disposable = vscode.commands.registerCommand('claude-mcp-vscode.callMCP', async () => {
        // Set up debug log file in /out
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const outDir = path.join(workspaceFolder.uri.fsPath, 'out');
            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }
            debugLogPath = path.join(outDir, 'vscode-ext-claude-commitension-debug.log');
            // Clear previous log
            fs.writeFileSync(debugLogPath, '');
        }

        log('=== Commit Message AI Button Clicked ===');

        // Check if already generating
        if (isGeneratingCommit) {
            vscode.window.showWarningMessage('A commit message is already being generated. Please wait...');
            return;
        }

        isGeneratingCommit = true;

        // Show inactive/processing state with spinning icon and muted appearance
        statusBarItem.text = "$(sync~spin) Commit Message AI";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        statusBarItem.command = undefined; // Make icon inactive/non-clickable during generation

        // Update command to show it's working (this affects the SCM button too)
        vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.isGenerating', true);

        try {
            // FAIL-EARLY: Validate git state FIRST before doing anything else
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                vscode.window.showErrorMessage('Git extension not found');
                isGeneratingCommit = false;
                return;
            }

            const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
            const api = git.getAPI(1);

            if (api.repositories.length === 0) {
                vscode.window.showErrorMessage('No Git repository found');
                isGeneratingCommit = false;
                return;
            }

            const repo = api.repositories[0];

            // Validate git state IMMEDIATELY - fail early if invalid
            const validationError = await validateGitState(repo);
            if (validationError) {
                vscode.window.showErrorMessage(validationError);
                isGeneratingCommit = false;
                statusBarItem.text = "$(robot) Commit Message AI";
                statusBarItem.backgroundColor = undefined;
                statusBarItem.command = "claude-mcp-vscode.callMCP"; // Restore active state
                vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.isGenerating', false);
                return;
            }

            // Only proceed with workspace and agent setup if git state is valid
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                isGeneratingCommit = false;
                return;
            }

            const workspacePath = workspaceFolder.uri.fsPath;
            const agentFilePath = path.join(workspacePath, '.claude', 'agents', 'vscode-extension-commit-button.md');

            // Execute the agent with progress indicator
            let commitMessage: string;
            const clockEmojis = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
            let clockIndex = 0;
            try {
                commitMessage = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `${clockEmojis[0]}`,
                    cancellable: false
                }, async (progress) => {
                    // Show randomized initial message
                    const randomMessages = [
                        "🚀 Initializing 3-agent workflow...",
                        "🔍 Preparing semantic commit generation...",
                        "⚡ Starting commit analysis pipeline...",
                        "🎯 Launching agent orchestration...",
                        "🤖 Booting up commit generation...",
                        "💫 Activating intelligent commit system...",
                    ];
                    const initialMsg = randomMessages[Math.floor(Math.random() * randomMessages.length)];
                    progress.report({ message: initialMsg });
                    // Track the last real progress stage and overall elapsed time
                    let lastStage = '';
                    let lastProgressTime = Date.now();
                    let startTime = Date.now();
                    let simulationInterval: NodeJS.Timeout | null = null;
                    let tickCount = 0;
                    let currentGlobalTime = '00s'; // Track latest global time from server
                    let lastStageTimeInSec = 0; // Track when last stage started (in seconds from start)

                    // Rotate clock emoji every 5 seconds (one hour on clock = 5 seconds real time)
                    const clockInterval = setInterval(() => {
                        clockIndex = (clockIndex + 1) % clockEmojis.length;
                        statusBarItem.text = `$(sync~spin) ${clockEmojis[clockIndex]} ${currentGlobalTime}`;
                    }, 5000);

                    // Start the actual agent execution with real progress callback
                    const agentPromise = executeAgent(workspacePath, agentFilePath, (realProgress) => {
                        log('[Real Progress Received] ' + realProgress);

                        // Format: "stage (00m00s:00s) - message"
                        // Extract global time and message
                        const timeMatch = realProgress.match(/\(([^:]+):([^)]+)\) - (.+)$/);
                        log('[Time Match Result] ' + JSON.stringify(timeMatch));
                        if (timeMatch) {
                            const globalTime = timeMatch[1].trim();
                            const message = timeMatch[3].trim();
                            log('[Extracted Global Time] ' + globalTime);
                            // Store current global time for simulated messages
                            currentGlobalTime = globalTime;
                            // Update status bar with global time (clock will rotate via interval)
                            statusBarItem.text = `$(sync~spin) ${clockEmojis[clockIndex]} ${globalTime}`;
                            // Display just the message (no time suffix)
                            progress.report({ message: message });
                        } else {
                            log('[Time Match Failed] Showing original message');
                            progress.report({ message: realProgress });
                        }
                        lastProgressTime = Date.now();

                        // Extract stage from message and log agent execution
                        if (realProgress.includes('generator') || realProgress.includes('gen-')) {
                            if (lastStage !== 'generator') {
                                lastStageTimeInSec = Math.floor((Date.now() - startTime) / 1000);
                            }
                            lastStage = 'generator';
                            if (realProgress.includes('Generating initial commit')) {
                                outputChannel.appendLine('');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                                outputChannel.appendLine('🤖 Running: vscode-extension-commit-button.md (generator)');
                                outputChannel.appendLine('Content: Git diff + documentation + module metadata');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                            }
                        } else if (realProgress.includes('reviewer') || realProgress.includes('rev-')) {
                            if (lastStage !== 'reviewer') {
                                lastStageTimeInSec = Math.floor((Date.now() - startTime) / 1000);
                            }
                            lastStage = 'reviewer';
                            if (realProgress.includes('Reviewing commit')) {
                                outputChannel.appendLine('');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                                outputChannel.appendLine('🔍 Running: commit-message-reviewer.md');
                                outputChannel.appendLine('Content: Generated commit message');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                            }
                        } else if (realProgress.includes('approver') || realProgress.includes('app-')) {
                            if (lastStage !== 'approver') {
                                lastStageTimeInSec = Math.floor((Date.now() - startTime) / 1000);
                            }
                            lastStage = 'approver';
                            if (realProgress.includes('Final approval')) {
                                outputChannel.appendLine('');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                                outputChannel.appendLine('✅ Running: commit-message-approver.md');
                                outputChannel.appendLine('Content: Commit message + review feedback');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                            }
                        } else if (realProgress.includes('concerns')) {
                            lastStage = 'concerns';
                            if (realProgress.includes('Fixing concerns')) {
                                outputChannel.appendLine('');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                                outputChannel.appendLine('🔧 Running: commit-message-concerns-handler.md');
                                outputChannel.appendLine('Content: Commit message with approval concerns');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                            }
                        } else if (realProgress.includes('title')) {
                            lastStage = 'title';
                            if (realProgress.includes('Generating commit title')) {
                                outputChannel.appendLine('');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                                outputChannel.appendLine('✨ Running: commit-title-generator.md');
                                outputChannel.appendLine('Content: Complete commit message (all modules)');
                                outputChannel.appendLine('═══════════════════════════════════════════════════════');
                            }
                        } else if (realProgress.includes('git') || realProgress.includes('docs')) {
                            lastStage = 'setup';
                        }

                        progress.report({ message: realProgress });
                    });

                    // Smart simulation: Always show progress based on time elapsed
                    simulationInterval = setInterval(() => {
                        tickCount++;
                        const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
                        const timeSinceLastProgress = Math.floor((Date.now() - lastProgressTime) / 1000);

                        log(`[Simulation Tick ${tickCount}] Stage: ${lastStage}, Total: ${totalElapsed}s, Since last: ${timeSinceLastProgress}s`);

                        // Smart stage detection: if no stage yet but time has passed, assume we're in generator
                        if (!lastStage && totalElapsed > 5) {
                            lastStage = 'generator';
                            log('[Stage Detection] No progress received, assuming generator stage');
                        }

                        // Show sub-progress based on current stage (using actual global time from server)
                        if (lastStage === 'generator') {
                            if (timeSinceLastProgress < 10) {
                                progress.report({ message: `🤖 Analyzing changes... | ${currentGlobalTime}` });
                            } else if (timeSinceLastProgress < 20) {
                                progress.report({ message: `🔮 Discombulating abstractions into lists... | ${currentGlobalTime}` });
                            } else if (timeSinceLastProgress < 35) {
                                progress.report({ message: `📝 Writing module sections... | ${currentGlobalTime}` });
                            } else if (timeSinceLastProgress < 50) {
                                progress.report({ message: `✨ Finalizing commit message... | ${currentGlobalTime}` });
                            } else {
                                progress.report({ message: `⏳ Still generating... | ${currentGlobalTime}` });
                            }
                        } else if (lastStage === 'reviewer') {
                            if (timeSinceLastProgress < 10) progress.report({ message: `Reviewing commit message... | ${currentGlobalTime}` });
                            else progress.report({ message: `Reviewing commit message... | ${currentGlobalTime}` });
                        } else if (lastStage === 'approver') {
                            if (timeSinceLastProgress < 8) progress.report({ message: `Final approval... | ${currentGlobalTime}` });
                            else progress.report({ message: `Final approval... | ${currentGlobalTime}` });
                        } else if (lastStage === 'concerns') {
                            if (timeSinceLastProgress < 12) progress.report({ message: `Fixing concerns... | ${currentGlobalTime}` });
                            else progress.report({ message: `Fixing concerns... | ${currentGlobalTime}` });
                        } else if (lastStage === 'title') {
                            if (timeSinceLastProgress < 8) progress.report({ message: `✨ Generating commit title... | ${currentGlobalTime}` });
                            else progress.report({ message: `✨ Generating commit title... | ${currentGlobalTime}` });
                        } else if (lastStage === 'setup') {
                            progress.report({ message: `Setting up context... | ${currentGlobalTime}` });
                        } else {
                            // No stage detected yet - show generic progress
                            progress.report({ message: `Starting workflow... | ${currentGlobalTime}` });
                        }
                    }, 3000);

                    try {
                        const result = await agentPromise;
                        if (simulationInterval) clearInterval(simulationInterval);
                        if (clockInterval) clearInterval(clockInterval);
                        progress.report({ message: "Complete!" });
                        return result;
                    } catch (error) {
                        if (simulationInterval) clearInterval(simulationInterval);
                        if (clockInterval) clearInterval(clockInterval);
                        throw error;
                    }
                });
            } catch (error) {
                // Error occurred during agent execution - do NOT show success message
                isGeneratingCommit = false;
                throw error;
            }

            // Only reach here if commit message was successfully generated
            // Set the commit message in the repository input box
            repo.inputBox.value = commitMessage;

            vscode.window.showInformationMessage('✓ Commit message generated and ready to review!');

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        } finally {
            // Always reset the flag and status bar, even if there was an error
            isGeneratingCommit = false;
            clickCount = 0; // Reset click counter
            statusBarItem.text = "$(robot) Commit Message AI";
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = "claude-mcp-vscode.callMCP"; // Restore active/clickable state
            vscode.commands.executeCommand('setContext', 'claude-mcp-vscode.isGenerating', false);
        }
    });

    context.subscriptions.push(disposable);
}

/**
 * Validates the git repository state before generating commit message
 * @param repo The git repository
 * @returns Error message if validation fails, null if valid
 */
async function validateGitState(repo: any): Promise<string | null> {
    // Get the current repository state
    const state = repo.state;

    // Debug: Log the state to understand what we're working with
    console.log('Git State Debug:', {
        workingTreeChanges: state.workingTreeChanges?.length || 0,
        indexChanges: state.indexChanges?.length || 0,
        mergeChanges: state.mergeChanges?.length || 0,
        untrackedChanges: state.untrackedChanges?.length || 0
    });

    // Check if there are staged changes (indexChanges)
    const hasStagedChanges = (state.indexChanges?.length || 0) > 0;

    if (!hasStagedChanges) {
        return 'No staged changes found. Stage your changes before generating a commit message.';
    }

    // Check if there are unstaged changes (working tree changes that aren't staged)
    // This includes both modified files and untracked files
    const hasUnstagedChanges = (state.workingTreeChanges?.length || 0) > 0;

    if (hasUnstagedChanges) {
        return 'You have unstaged changes. Please stage or stash them before generating a commit message.';
    }

    // All validations passed
    return null;
}

async function executeAgent(workspacePath: string, agentFilePath: string, onProgress?: (message: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        // Execute the agent using the MCP server
        const mcpServerPath = path.join(workspacePath, 'src', 'mcp', 'vscode');

        // No API key needed - MCP server uses Claude Code CLI
        const childProcess = child_process.spawn('go', ['run', '.'], {
            cwd: mcpServerPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        });

        let outputLines: string[] = [];
        let errorOutput = '';
        let buffer = '';

        // Read stdout line by line for streaming progress
        childProcess.stdout.on('data', (data) => {
            buffer += data.toString();

            // Process complete lines
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex);
                buffer = buffer.substring(newlineIndex + 1);

                if (line.trim()) {
                    outputLines.push(line);
                    log('[MCP Server Output] ' + line);

                    // Try to parse as progress notification
                    try {
                        const parsed = JSON.parse(line);
                        log('[MCP Parsed JSON] ' + JSON.stringify(parsed));
                        if (parsed.method === '$/progress' && parsed.params && onProgress) {
                            // Combine stage (with times) and message for display
                            const progressText = `${parsed.params.stage} - ${parsed.params.message}`;
                            log('[MCP Progress] ' + progressText);
                            onProgress(progressText);
                        }
                    } catch (e) {
                        // Not JSON or not a progress notification, that's fine
                        log('[MCP Parse Error] ' + e);
                    }
                }
            }
        });

        childProcess.stderr.on('data', (data) => {
            const stderrText = data.toString();
            errorOutput += stderrText;
            log('[MCP Server Debug] ' + stderrText);
        });

        childProcess.on('close', (code) => {
            if (code !== 0 && errorOutput) {
                reject(new Error(`MCP server error: ${errorOutput}`));
                return;
            }

            try {
                // The last line should be the JSON-RPC response
                const lastLine = outputLines[outputLines.length - 1];
                const response = JSON.parse(lastLine);

                if (response.error) {
                    reject(new Error(response.error.message));
                    return;
                }

                // Extract the commit message from the tool result
                if (response.result && response.result.content && response.result.content[0]) {
                    const commitMessage = response.result.content[0].text;

                    // Check if the response is actually an error
                    if (commitMessage.startsWith('ERROR:')) {
                        reject(new Error(commitMessage.substring(7).trim()));
                        return;
                    }

                    resolve(commitMessage);
                } else {
                    reject(new Error('Invalid response format from MCP server'));
                }
            } catch (parseError) {
                reject(new Error(`Failed to parse MCP response: ${parseError}. Output: ${outputLines.join('\n')}`));
            }
        });

        // Send the agent file path as input
        const request = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'execute-agent',
                arguments: {
                    agentFile: agentFilePath
                }
            }
        };

        childProcess.stdin.write(JSON.stringify(request) + '\n');
        childProcess.stdin.end();
    });
}

export function deactivate() {
    console.log('Claude MCP VSCode extension is now deactivated');
}
