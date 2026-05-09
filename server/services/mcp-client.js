/**
 * MCP Client — spawns GitHub MCP Server as a subprocess and provides
 * tool listing and calling capabilities via the Model Context Protocol.
 *
 * Lifecycle: init(token) → listTools() / callTool() → close()
 * The server subprocess is spawned lazily on first init() call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client = null;
let transport = null;
let currentToken = null;
let cachedUsername = null;

/**
 * Initialize (or reinitialize) the MCP client with a GitHub token.
 * Spawns the GitHub MCP Server as a child process via stdio.
 */
/**
 * Fetch the GitHub username associated with a token.
 * Calls GitHub REST API GET /user.
 * @param {string} token - GitHub personal access token
 * @returns {Promise<string>} GitHub login username
 */
async function fetchUsername(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'resume-tailor',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API /user 失败 (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.login) throw new Error('GitHub API 未返回用户名');
  return data.login;
}

export async function init(token) {
  if (!token) throw new Error('GitHub token is required');

  // Reuse existing connection if token hasn't changed
  if (client && currentToken === token) return;

  // Close existing connection if token changed
  if (client) await close();

  currentToken = token;

  // Fetch username before spawning MCP server (lightweight, validates token)
  cachedUsername = await fetchUsername(token);

  transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      ...process.env,
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
    },
    stderr: 'pipe',
  });

  client = new Client(
    { name: 'resume-tailor', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  // Drain stderr to prevent buffer buildup and log MCP server errors
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.error('[MCP stderr]', msg);
    });
    transport.stderr.resume();
  }
}

/**
 * List all tools exposed by the GitHub MCP Server.
 * Returns Array<{ name, description, inputSchema }>
 */
export async function listTools() {
  if (!client) throw new Error('MCP client not initialized. Call init(token) first.');
  const { tools } = await client.listTools();
  return tools;
}

/**
 * Call a specific tool on the GitHub MCP Server.
 * @param {string} name - Tool name (e.g. 'search_repositories')
 * @param {object} args - Tool arguments
 * @returns {{ content: Array, isError?: boolean }}
 */
export async function callTool(name, args = {}) {
  if (!client) throw new Error('MCP client not initialized. Call init(token) first.');
  return await client.callTool({ name, arguments: args });
}

/**
 * Close the MCP client and terminate the server subprocess.
 */
export async function close() {
  if (client) {
    try { await client.close(); } catch (_) {}
    client = null;
  }
  if (transport) {
    try { await transport.close(); } catch (_) {}
    transport = null;
  }
  currentToken = null;
  cachedUsername = null;
}

/**
 * Check if the client is currently connected.
 */
export function isConnected() {
  return client !== null;
}

/**
 * Get the cached GitHub username (from init).
 * Returns null if not initialized.
 */
export function getUsername() {
  return cachedUsername;
}
