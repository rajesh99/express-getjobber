'use strict';

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const open = require('open');
const fs = require('fs').promises;

// API Configuration
const API_CONFIG = {
  baseUrl: 'https://api.getjobber.com',
  endpoints: {
    authorize: '/api/oauth/authorize',
    token: '/api/oauth/token',
    graphql: '/api/graphql'
  }
};

// Store tokens in memory
let storedTokens = null;
let server = null;

const port = 3000;
const callbackUrl = `http://localhost:${port}/callback`;
const TOKEN_FILE = 'auth-tokens.json';

/**
 * Save tokens to file
 */
async function saveTokens(tokens) {
  try {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`✓ Tokens saved to ${TOKEN_FILE}\n`);
  } catch (error) {
    console.error(`Warning: Could not save tokens to ${TOKEN_FILE}:`, error.message);
  }
}

/**
 * Load tokens from file
 */
async function loadTokens() {
  try {
    const data = await fs.readFile(TOKEN_FILE, 'utf-8');
    const tokens = JSON.parse(data);
    console.log(`✓ Loaded existing tokens from ${TOKEN_FILE}\n`);
    return tokens;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`ℹ No existing token file found at ${TOKEN_FILE}\n`);
    } else {
      console.error(`Warning: Could not load tokens from ${TOKEN_FILE}:`, error.message);
    }
    return null;
  }
}

/**
 * Main function to authenticate and retrieve GetJobber clients
 */
async function authenticateAndGetClients() {
  console.log('Starting GetJobber authentication process...\n');

  // Check for required environment variables
  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
    console.error('ERROR: Missing required environment variables!');
    console.error('Please set CLIENT_ID and CLIENT_SECRET in your environment.');
    process.exit(1);
  }

  // Initialize Express app
  const app = express();

  // Promise to wait for authentication to complete
  const authPromise = new Promise((resolve, reject) => {

    // Callback service parsing the authorization token and asking for the access token
    app.get('/callback', async (req, res) => {
      const { code } = req.query;

      if (!code) {
        const error = 'No authorization code received';
        console.error('ERROR:', error);
        res.status(400).send('<h1>Authentication Failed</h1><p>No authorization code received.</p>');
        reject(new Error(error));
        return;
      }

      try {
        console.log('Received authorization code, exchanging for access token...');

        const tokenResponse = await fetch(`${API_CONFIG.baseUrl}${API_CONFIG.endpoints.token}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: callbackUrl,
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET
          })
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.text();
          console.error('Token Error Response:', errorData);
          throw new Error(`Token request failed with status ${tokenResponse.status}`);
        }

        const tokenData = await tokenResponse.json();

        // Store the tokens
        storedTokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token
        };

        console.log('✓ Access Token received:', storedTokens.access_token.substring(0, 20) + '...');
        console.log('✓ Refresh Token received:', storedTokens.refresh_token ? storedTokens.refresh_token.substring(0, 20) + '...' : 'N/A');
        console.log('');

        // Save tokens to file
        await saveTokens(storedTokens);

        // Send success response to browser
        res.status(200).send(`
          <h1>Authentication Successful!</h1>
          <p>You can close this window now.</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        `);

        // Resolve the promise with the tokens
        resolve(storedTokens);
      } catch (error) {
        console.error('Access Token Error:', error.message);
        res.status(500).send('<h1>Authentication Failed</h1><p>' + error.message + '</p>');
        reject(error);
      }
    });

    // Handle root path
    app.get('/', (req, res) => {
      res.send('<h1>GetJobber Authentication</h1><p>Redirecting to authorization...</p>');
    });
  });

  // Start the server
  await new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`✓ Local server started at http://localhost:${port}`);
      resolve();
    });
  });

  // Build authorization URL
  const authUrl = new URL(API_CONFIG.endpoints.authorize, API_CONFIG.baseUrl);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', process.env.CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', callbackUrl);
  authUrl.searchParams.append('scope', 'notifications');
  authUrl.searchParams.append('state', '3(#0/!~');

  console.log('✓ Opening browser for authentication...');
  console.log('  Authorization URL:', authUrl.toString());
  console.log('');

  // Open the browser automatically
  try {
    await open(authUrl.toString());
    console.log('✓ Browser opened successfully');
    console.log('  Please complete the authentication in the browser...');
    console.log('');
  } catch (error) {
    console.error('Failed to open browser automatically:', error.message);
    console.log('Please manually open this URL in your browser:');
    console.log(authUrl.toString());
    console.log('');
  }

  // Wait for authentication to complete
  try {
    await authPromise;
    console.log('✓ Authentication completed successfully!\n');
  } catch (error) {
    console.error('Authentication failed:', error.message);
    closeServer();
    process.exit(1);
  }

  // Now fetch the clients
  console.log('Fetching GetJobber clients...\n');
  const clients = await fetchClients();

  return { tokens: storedTokens, clients };
}

/**
 * Fetch clients from GetJobber using GraphQL
 */
async function fetchClients() {
  if (!storedTokens || !storedTokens.access_token) {
    throw new Error('Not authenticated. Please login first.');
  }

  const query = `
    query {
      clients {
        nodes {
          id
          firstName
          lastName
          billingAddress {
            city
          }
        }
        totalCount
      }
    }
  `;

  try {
    const response = await fetch(`${API_CONFIG.baseUrl}${API_CONFIG.endpoints.graphql}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Authorization': `Bearer ${storedTokens.access_token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-01-20'
      },
      body: JSON.stringify({ query }),
    });

    if (response.status === 401) {
      throw new Error('Authentication failed. The access token may be invalid or expired.');
    }

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Failed to parse API response: ${responseText}`);
    }

    if (data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(data.errors, null, 2));
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    if (!data.data) {
      throw new Error('Unexpected response structure from API');
    }

    console.log('✓ Successfully retrieved clients!');
    console.log(`  Total clients: ${data.data.clients.totalCount}\n`);

    return data.data.clients;
  } catch (error) {
    console.error('Error fetching clients:', error.message);
    throw error;
  }
}

/**
 * Close the Express server
 */
function closeServer() {
  if (server) {
    console.log('\nClosing server...');
    server.close();
    server = null;
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    // Check for existing tokens
    const existingTokens = await loadTokens();

    let result;
    if (existingTokens && existingTokens.access_token) {
      console.log('Using existing tokens from file...\n');
      storedTokens = existingTokens;

      // Try to fetch clients with existing tokens
      try {
        console.log('Fetching GetJobber clients...\n');
        const clients = await fetchClients();
        result = { tokens: storedTokens, clients };
      } catch (error) {
        console.error('Error using existing tokens:', error.message);
        console.log('Tokens may be invalid or expired. Starting new authentication...\n');
        storedTokens = null;
        result = await authenticateAndGetClients();
      }
    } else {
      result = await authenticateAndGetClients();
    }

    console.log('========================================');
    console.log('AUTHENTICATION & CLIENT RETRIEVAL COMPLETE');
    console.log('========================================\n');

    console.log('Tokens:');
    console.log('  Access Token:', result.tokens.access_token);
    console.log('  Refresh Token:', result.tokens.refresh_token || 'N/A');
    console.log('');

    console.log('Clients:');
    console.log(JSON.stringify(result.clients, null, 2));

    // Close the server
    closeServer();

    console.log('\n✓ Process completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Process failed:', error.message);
    closeServer();
    process.exit(1);
  }
}

// Run the main function
main();
